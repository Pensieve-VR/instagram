// 게시 한 걸음씩 — 플랫폼 API 를 직접 부르지 않고 api(create·status·publish·comment) 를 받아 쓴다(시험에서 가짜로 바꾼다).
// 한 번에 쓸 호출 수(budget)를 넘거나 처리 중(IN_PROGRESS)이면 멈추고 progress 를 돌려준다 → 다음 틱에 이어 간다.
//   progress = { items:[{ c: 자식 컨테이너, ok }], parent, pub, reply, replied }
// 결과 state: posted(올라감) | publishing(이어 가야 함) | failed(이유 error). 첫 댓글 실패는 warn 으로만.
const WAIT = Symbol('wait');

export function childParams(platform, item) {
  const video = item.kind === 'video';
  if (platform === 'ig') return video ? { is_carousel_item: true, media_type: 'VIDEO', video_url: item.url } : { is_carousel_item: true, image_url: item.url };
  return video ? { is_carousel_item: true, media_type: 'VIDEO', video_url: item.url } : { is_carousel_item: true, media_type: 'IMAGE', image_url: item.url };
}

// 단일(또는 캐러셀 부모) 컨테이너. caption 은 이미 해시태그까지 합친 글.
export function containerParams(platform, post, children = []) {
  const m = (post.media || [])[0] || {};
  const video = m.kind === 'video';
  const text = String(post.caption || '');
  if (platform === 'ig') {
    switch (post.format) {
      case 'carousel': return { media_type: 'CAROUSEL', children: children.join(','), caption: text };
      case 'reel': {
        const p = { media_type: 'REELS', video_url: m.url, caption: text, share_to_feed: true };
        if (post.cover_url) p.cover_url = post.cover_url;
        if (post.trial) p.trial_params = JSON.stringify({ graduation_strategy: 'MANUAL' });
        return p;
      }
      case 'story': return video ? { media_type: 'STORIES', video_url: m.url } : { media_type: 'STORIES', image_url: m.url };
      default: return { image_url: m.url, caption: text };
    }
  }
  // Threads
  switch (post.format) {
    case 'carousel': return { media_type: 'CAROUSEL', children: children.join(','), text };
    case 'image': return { media_type: 'IMAGE', image_url: m.url, text };
    case 'video': return { media_type: 'VIDEO', video_url: m.url, text };
    default: return { media_type: 'TEXT', text };
  }
}

export async function step(post, { platform, api, budget = 30 }) {
  const p = JSON.parse(JSON.stringify(post.progress && typeof post.progress === 'object' ? post.progress : {}));
  p.items = Array.isArray(p.items) ? p.items : [];
  let used = 0;
  const spend = () => { if (used >= budget) throw WAIT; used++; };
  const out = (state, extra = {}) => ({ state, progress: p, platform_post_id: post.platform_post_id || p.pub || '', ...extra });
  try {
    if (!post.platform_post_id && !p.pub) {
      const media = post.media || [];
      if (post.format === 'carousel') {
        for (let i = 0; i < media.length; i++) {
          if (!p.items[i]) { spend(); p.items[i] = { c: await api.create(childParams(platform, media[i])), ok: false }; }
        }
        for (let i = 0; i < p.items.length; i++) {
          if (p.items[i].ok) continue;
          spend();
          const s = await api.status(p.items[i].c);
          if (s.status === 'FINISHED' || s.status === 'PUBLISHED') p.items[i].ok = true;
          else if (s.status === 'IN_PROGRESS' || !s.status) return out('publishing');
          else if (s.status === 'EXPIRED') { reset(p); return out('publishing'); }
          else return out('failed', { error: `${i + 1}번째 장 — ${s.error || s.status}` });
        }
        if (!p.parent) { spend(); p.parent = await api.create(containerParams(platform, post, p.items.map((x) => x.c))); }
      } else if (!p.parent) { spend(); p.parent = await api.create(containerParams(platform, post)); }

      spend();
      const s = await api.status(p.parent);
      if (s.status === 'FINISHED') { spend(); p.pub = await api.publish(p.parent); }
      else if (s.status === 'PUBLISHED') return out('failed', { error: '이미 게시된 컨테이너 — 게시물 ID 를 모릅니다. 계정에서 확인해 주세요' });
      else if (s.status === 'IN_PROGRESS' || !s.status) return out('publishing');
      else if (s.status === 'EXPIRED') { reset(p); return out('publishing'); }
      else return out('failed', { error: s.error || s.status });
    }

    const id = post.platform_post_id || p.pub;
    let warn = '';
    const reply = String(post.first_reply || '').trim();
    if (reply && !p.replied) {
      try {
        if (platform === 'ig') { spend(); await api.comment(id, reply); p.replied = true; }
        else {
          if (!p.reply) { spend(); p.reply = await api.create({ media_type: 'TEXT', text: reply, reply_to_id: id }); }
          spend();
          const s = await api.status(p.reply);
          if (s.status === 'IN_PROGRESS' || !s.status) return out('publishing');
          if (s.status !== 'FINISHED') throw new Error(s.error || s.status);
          spend(); await api.publish(p.reply); p.replied = true;
        }
      } catch (e) {
        if (e === WAIT) throw e;
        p.replied = true; // 첫 댓글 때문에 다시 올리지는 않는다
        warn = '첫 댓글을 못 달았습니다 — ' + String((e && e.message) || e).slice(0, 160);
      }
    }
    return out('posted', { platform_post_id: id, warn });
  } catch (e) {
    if (e === WAIT) return out('publishing');
    throw e; // 네트워크·토큰 오류 — 부른 쪽이 횟수·만료를 다룬다
  }
}
function reset(p) { for (const k of Object.keys(p)) delete p[k]; p.items = []; }
