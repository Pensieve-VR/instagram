// 폴더 → 게시물 묶음. 화면(브라우저)과 시험(node)이 같이 쓰는 순수 함수 — DOM 을 쓰지 않는다.
// 규칙: 미디어가 든 맨 아래 폴더 하나 = 게시물 하나(스토리만 사진마다 하나).
//   플랫폼은 경로의 「인스타·스레드·X」, 언어는 「영어·_EN」 이 있으면 en.
//   캡션 = 캡션.txt·글.txt · 첫 댓글 = 첫댓글.txt · X 는 첫스레드.txt 가 본문.
const IMG = /\.(png|jpe?g|webp)$/i;
const VID = /\.(mp4|mov|m4v)$/i;
const SKIP_DIR = /프로필|profile|하이라이트|highlight|^_/i;
const SKIP_FILE = /헤더|header|로고|logo|그리드미리보기|preview/i;
const CAPTION = /^(캡션|글|caption|post|text|첫스레드|thread)\.(txt|md)$/i;
const REPLY = /^(첫댓글|첫_댓글|reply|first[_-]?reply)\.(txt|md)$/i;
const COVER = /^(커버|cover|thumb)/i;

export function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), 'ko', { numeric: true, sensitivity: 'base' });
}

export function platformOf(segs) {
  for (const s of [...segs].reverse()) { // 깊은 폴더부터 — 맨 위 폴더 이름에 「인스타_스레드」가 같이 있어도 헷갈리지 않게
    if (/^x$|트위터|twitter/i.test(s)) return 'x';
    if (/스레드|threads?(_|$)/i.test(s)) return 'th';
    if (/인스타|instagram|^ig(_|$)/i.test(s)) return 'ig';
  }
  return '';
}
export const langOf = (segs) => (segs.some((s) => /영어|english|(^|_)en$/i.test(s)) ? 'en' : 'ko');

const titleOf = (dir) => dir.replace(/^\d+[_\s-]*/, '').replace(/_/g, ' ').trim() || dir;

// paths: ['root/인스타/05_피드_P1/01.png', ...] (문자열) → [{ dir, title, platform, lang, format, media[], cover, caption, reply, pinned }]
export function groupFiles(paths) {
  const dirs = new Map();
  for (const p of paths.map(String)) {
    const segs = p.split('/').filter(Boolean);
    if (segs.length < 2) continue;
    const name = segs[segs.length - 1];
    const dirSegs = segs.slice(0, -1);
    if (dirSegs.some((s) => SKIP_DIR.test(s))) continue;
    const key = dirSegs.join('/');
    if (!dirs.has(key)) dirs.set(key, { segs: dirSegs, files: [] });
    dirs.get(key).files.push(name);
  }
  const out = [];
  for (const key of [...dirs.keys()].sort(naturalCmp)) {
    const { segs, files } = dirs.get(key);
    const platform = platformOf(segs);
    if (!platform) continue;
    const lang = langOf(segs);
    const leaf = segs[segs.length - 1];
    files.sort(naturalCmp);
    const at = (f) => `${key}/${f}`;
    const caption = files.find((f) => CAPTION.test(f));
    const reply = files.find((f) => REPLY.test(f));
    const videos = files.filter((f) => VID.test(f));
    const covers = files.filter((f) => IMG.test(f) && COVER.test(f));
    const images = files.filter((f) => IMG.test(f) && !COVER.test(f) && !SKIP_FILE.test(f));
    const base = { dir: key, title: titleOf(leaf), platform, lang, caption: caption ? at(caption) : '', reply: reply ? at(reply) : '', cover: '', pinned: /고정|pinned?/i.test(leaf) };

    if (platform === 'ig' && /스토리|story/i.test(leaf)) {
      for (const f of [...images, ...videos].sort(naturalCmp)) out.push({ ...base, title: `${base.title} ${titleOf(f.replace(/\.[^.]+$/, ''))}`, format: 'story', media: [at(f)], caption: '', reply: '' });
      continue;
    }
    if (platform === 'ig') {
      if (videos.length === 1 && images.length === 0) out.push({ ...base, format: 'reel', media: [at(videos[0])], cover: covers[0] ? at(covers[0]) : '' });
      else {
        const media = [...images, ...videos].sort(naturalCmp).map(at);
        if (!media.length) continue;
        out.push({ ...base, format: media.length === 1 ? 'image' : 'carousel', media: media.slice(0, 20) });
      }
      continue;
    }
    if (platform === 'th') {
      const media = [...images, ...videos].sort(naturalCmp).map(at);
      if (!media.length && !caption) continue;
      const format = !media.length ? 'text' : media.length > 1 ? 'carousel' : VID.test(media[0]) ? 'video' : 'image';
      out.push({ ...base, format, media: media.slice(0, 20) });
      continue;
    }
    // X — 본문 + 사진 4장까지, 한 묶음 = 스레드 하나
    const media = images.map(at).slice(0, 4);
    if (!media.length && !caption) continue;
    out.push({ ...base, format: 'thread', media, reply: '' });
  }
  return out;
}
