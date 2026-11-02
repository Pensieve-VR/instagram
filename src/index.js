// 홍보실 Worker — 정적 화면(ASSETS) + API + 크론. 길(route)은 아래 표 하나로 읽는다.
import { login, verify, configured, slow, makeState, readState } from '../lib/auth.js';
import { err, ok, originOk, readJson, publicOrigin, idFor } from '../lib/http.js';
import { db, event, isId, J } from '../lib/db.js';
import { aiReady, DEFAULT_MODEL } from '../lib/ai.js';
import * as meta from '../lib/meta.js';
import * as ops from '../lib/ops.js';
import { mergeSettings, signals, weekStart, DAY, transition } from '../lib/plan.js';
import { monogramSvg, monogramHtml, renderJpeg, renderReady, toJpeg } from '../lib/render.js';
import { sealReady } from '../lib/crypto.js';
import { mediaReady, getMedia, putMedia, deleteMedia, deletePrefix } from '../lib/media.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      if (url.pathname.startsWith('/media/')) return await media(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('unhandled', e && e.stack || e);
      return err(status, status >= 500 ? 'server_error' : e.message, e.detail ? { detail: e.detail } : {});
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cron(env, controller.scheduledTime || Date.now()));
  },
};

// 크론 하나(5분). 00:00~00:04 UTC 틱(09:00 KST)은 하루 일도 함께 한다.
export const isDailyTick = (ms) => { const d = new Date(ms); return d.getUTCHours() === 0 && d.getUTCMinutes() < 5; };

async function cron(env, at) {
  try {
    const due = await ops.publishDue(env);
    if (due.length) console.log('publishDue', JSON.stringify(due));
    if (isDailyTick(at)) { // 09:00 KST — 지표·요약·토큰
      await ops.refreshTokens(env);
      for (const id of await ops.allServiceIds(env)) {
        try { await ops.dailySummary(env, id); } catch (e) { console.error('daily', id, e && e.message); }
      }
    }
  } catch (e) { console.error('cron', e && e.stack || e); }
}

// ---------- 공개 미디어 (Meta 가 가져간다) ----------
async function media(request, env, url) {
  let key = '';
  try { key = decodeURIComponent(url.pathname.slice('/media/'.length)); } catch { return new Response('not found', { status: 404 }); }
  if (!/^[a-z]\/s[a-z0-9]+\/[A-Za-z0-9._-]+$/.test(key) || !mediaReady(env)) return new Response('not found', { status: 404 });
  const obj = await getMedia(env, key);
  if (!obj) return new Response('not found', { status: 404 });
  const h = new Headers({ 'content-type': obj.contentType, 'content-length': String(obj.body.byteLength), 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' });
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers: h });
}

// ---------- API ----------
async function api(request, env, ctx, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // ['services', id, ...]
  const m = request.method;
  const origin = publicOrigin(request, env);

  if (seg[0] === 'health' && m === 'GET') {
    return ok({ ai: aiReady(env), render: renderReady(env), store: !!env.DB, media: mediaReady(env), passwords: configured(env), secret: sealReady(env), ig: meta.appReady(env, 'ig'), th: meta.appReady(env, 'th'), mock: env.MOCK_AI === '1', model: env.CLAUDE_MODEL || DEFAULT_MODEL, origin });
  }
  if (seg[0] === 'login' && m === 'POST') {
    if (!originOk(request, env)) return err(403, 'forbidden');
    if (!configured(env)) return err(503, 'no_passwords');
    const { body } = await readJson(request, 4000);
    const r = await login(env, String((body && body.password) || '').slice(0, 200));
    if (!r) { await slow(); return err(401, 'wrong'); }
    return ok(r);
  }
  // OAuth 되돌아오기 — 브라우저 리다이렉트라 Authorization 이 없다. state 서명으로 공간·서비스를 안다.
  if (seg[0] === 'oauth' && seg[2] === 'callback' && m === 'GET') return oauthCallback(request, env, url, seg[1], origin);

  // 여기부터는 열쇠 필요
  const who = await verify(request, env);
  if (!who) return err(401, 'locked');
  if (m !== 'GET' && !originOk(request, env)) return err(403, 'forbidden');
  const { space } = who;

  if (seg[0] === 'state' && m === 'GET') return state(env, space, url.searchParams.get('service') || '', origin, Number(url.searchParams.get('week')) || 0);

  if (seg[0] === 'oauth' && seg[2] === 'start' && m === 'GET') {
    const kind = seg[1]; const sid = url.searchParams.get('service') || '';
    if (!meta.KINDS[kind] || !isId(sid, 's')) return err(400, 'bad_request');
    if (!meta.appReady(env, kind)) return err(503, 'no_app', { kind });
    if (!sealReady(env)) return err(503, 'no_secret'); // 토큰을 봉인할 고정 비밀이 없으면 연결을 받지 않는다
    const service = await ops.getService(env, space, sid); if (!service) return err(404, 'not_found');
    const stateToken = await makeState(env, space, sid, kind);
    return ok({ url: meta.authUrl(env, kind, `${origin}/api/oauth/${kind}/callback`, stateToken) });
  }

  if (seg[0] === 'services') {
    if (seg.length === 1 && m === 'POST') {
      const { body, error } = await readJson(request, 20000); if (error) return err(400, error);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return err(400, 'name_required');
      let homepage = String(body.homepage || '').trim().slice(0, 300);
      if (homepage && !/^https?:\/\//i.test(homepage)) homepage = 'https://' + homepage;
      const service = await ops.createService(env, space, { name, homepage, brief: String(body.brief || '').slice(0, 2000) });
      let candidates = { candidates: [], oneliner: '' };
      if (aiReady(env)) { try { candidates = await ops.genCandidates(env, service); } catch (e) { await event(env, service.id, 'candidates.failed', e.message, 'warn'); } }
      // 홈페이지가 있으면 첫 소재로 읽어 둔다(실패해도 서비스는 만들어졌다)
      if (homepage) ctx.waitUntil((async () => { try { const pg = await ops.fetchPageText(homepage); await ops.addMaterial(env, service, { type: 'link', title: pg.title, url: homepage, content: pg.text }); } catch (e) { await event(env, service.id, 'material.link_failed', e.message, 'warn'); } })());
      return ok({ service: { ...service, ...candidates } }, 201);
    }
    const sid = seg[1];
    if (!isId(sid, 's')) return err(400, 'bad_request');
    const service = await ops.getService(env, space, sid);
    if (!service) return err(404, 'not_found');
    const sub = seg[2];

    if (seg.length === 2 && m === 'DELETE') {
      const d = await db(env);
      await d.batch(['posts', 'materials', 'channels', 'gates', 'events', 'daily'].map((t) => d.prepare(`DELETE FROM ${t} WHERE service_id=?`).bind(sid)).concat([d.prepare('DELETE FROM services WHERE id=?').bind(sid)]));
      if (mediaReady(env)) ctx.waitUntil((async () => { await deletePrefix(env, `m/${sid}/`); await deletePrefix(env, `c/${sid}/`); })().catch((e) => console.error('media cleanup', e && e.message)));
      return ok({ deleted: sid });
    }
    if (sub === 'candidates' && m === 'POST') { if (!aiReady(env)) return err(503, 'no_key'); return ok(await ops.genCandidates(env, service)); }
    if (sub === 'handle' && m === 'POST') {
      const { body, error } = await readJson(request, 2000); if (error) return err(400, error);
      const handle = await ops.pickHandle(env, service, body.handle);
      return ok({ handle });
    }
    if (sub === 'gates' && m === 'POST') {
      const { body, error } = await readJson(request, 2000); if (error) return err(400, error);
      await ops.setGate(env, service, seg[3], !!body.done);
      return ok({ gates: await ops.gatesOf(env, sid) });
    }
    if (sub === 'profile' && m === 'POST') { if (!aiReady(env)) return err(503, 'no_key'); return ok({ profile: await ops.genProfile(env, service) }); }
    if (sub === 'profile-image.svg' && m === 'GET') {
      const p = mergeSettings(service.settings).profile || { monogram: service.name.slice(0, 1), palette: 'rose' };
      return new Response(monogramSvg(p), { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (sub === 'profile-image.jpg' && m === 'GET') {
      if (!renderReady(env)) return err(503, 'no_render');
      const p = mergeSettings(service.settings).profile || { monogram: service.name.slice(0, 1), palette: 'rose' };
      const jpg = await renderJpeg(env, monogramHtml(p), { width: 1080, height: 1080 });
      return new Response(jpg, { headers: { 'content-type': 'image/jpeg', 'content-disposition': `attachment; filename="${service.handle || 'profile'}.jpg"`, 'cache-control': 'no-store' } });
    }
    if (sub === 'brief' && m === 'POST') {
      const { body, error } = await readJson(request, 20000); if (error) return err(400, error);
      const d = await db(env);
      let home = body.homepage != null ? String(body.homepage).trim().slice(0, 300) : null;
      if (home && !/^https?:\/\//i.test(home)) home = 'https://' + home;
      await d.prepare('UPDATE services SET name=COALESCE(NULLIF(?, \'\'), name), oneliner=COALESCE(?, oneliner), brief=COALESCE(?, brief), homepage=COALESCE(?, homepage), bio=COALESCE(?, bio), updated=? WHERE id=?')
        .bind(String(body.name || '').trim().slice(0, 60), body.oneliner != null ? String(body.oneliner).slice(0, 80) : null, body.brief != null ? String(body.brief).slice(0, 2000) : null, home, body.bio != null ? String(body.bio).slice(0, 150) : null, Date.now(), sid).run();
      return ok({ service: await ops.getService(env, space, sid) });
    }
    if (sub === 'settings' && m === 'POST') {
      const { body, error } = await readJson(request, 20000); if (error) return err(400, error);
      const prev = mergeSettings(service.settings); const next = mergeSettings({ ...prev, ...body, profile: prev.profile }); // 프로필은 화면에서 못 바꾼다
      const d = await db(env);
      await d.prepare('UPDATE services SET settings=?, updated=? WHERE id=?').bind(JSON.stringify(next), Date.now(), sid).run();
      await event(env, sid, 'settings.changed', `IG ${next.ig.slots.length}/주 · TH ${next.th.slots.length}/주 · ${next.approval}`);
      return ok({ settings: next });
    }
    if (sub === 'materials') {
      if (m === 'POST') return addMaterial(request, env, service, origin);
      if (m === 'DELETE' && isId(seg[3], 'm')) {
        const d = await db(env);
        const row = await d.prepare('SELECT r2_key FROM materials WHERE id=? AND service_id=?').bind(seg[3], sid).first();
        if (!row) return err(404, 'not_found');
        const detached = await ops.detachMaterial(env, sid, row.r2_key);
        await deleteMedia(env, row.r2_key);
        await d.prepare('DELETE FROM materials WHERE id=?').bind(seg[3]).run();
        return ok({ deleted: seg[3], detached });
      }
    }
    if (sub === 'plan' && m === 'POST') {
      if (!aiReady(env)) return err(503, 'no_key');
      const { body } = await readJson(request, 2000);
      const days = Math.min(14, Math.max(1, Number(body && body.days) || 7));
      const only = body && Array.isArray(body.channels) ? body.channels.filter((k) => k === 'ig' || k === 'th') : null;
      const fromMs = Math.max(Date.now(), Number(body && body.from) || 0); // 다른 주를 보고 있으면 그 주부터, 지난 시각은 세우지 않는다
      const made = await ops.planWeek(env, service, { origin, days, fromMs, channels: only && only.length ? only : null });
      return ok({ made });
    }
    if (sub === 'posts' && isId(seg[3], 'p')) {
      const post = await ops.getPost(env, sid, seg[3]);
      if (!post) return err(404, 'not_found');
      if (m === 'POST' && !seg[4]) {
        const { body, error } = await readJson(request, 20000); if (error) return err(400, error);
        const action = String(body.action || 'edit');
        if (!['approve', 'hold', 'skip', 'retry', 'edit'].includes(action)) return err(400, 'bad_action');
        return ok({ post: await ops.actPost(env, service, post, action, body) });
      }
      if (m === 'POST' && seg[4] === 'now') { // 지금 게시 — 처음부터(새 컨테이너), 크론과 겹치지 않게 점유
        if (!['draft', 'review', 'scheduled', 'failed'].includes(post.state)) return err(409, 'bad_transition');
        const d = await db(env);
        const r = await d.prepare("UPDATE posts SET state='publishing', scheduled_at=?, error='', container_id='', attempts=0, updated=? WHERE id=? AND state=?").bind(Date.now(), Date.now(), post.id, post.state).run();
        if (!(r.meta && r.meta.changes)) return err(409, 'bad_transition');
        const result = await ops.publishPost(env, { ...post, state: 'publishing', scheduled_at: Date.now(), error: '', container_id: '', attempts: 0 });
        return ok({ result, post: await ops.getPost(env, sid, post.id) });
      }
      if (m === 'POST' && seg[4] === 'regenerate') {
        if (!aiReady(env)) return err(503, 'no_key');
        if (['posted', 'publishing'].includes(post.state)) return err(409, 'bad_transition');
        const materials = await ops.materialsOf(env, sid);
        const recent = (await ops.postsOf(env, sid, Date.now() - 21 * DAY, Date.now() + 14 * DAY)).filter((p) => p.id !== post.id && p.state !== 'skipped').slice(-8);
        const gen = await ops.generatePost(env, service, post.channel, { angle: post.angle, materials, recent: recent.map((p) => ({ angle: p.angle, hook: p.hook })), when: new Date(post.scheduled_at).toISOString(), hasImage: post.media.length > 0 });
        const d = await db(env);
        const card = gen.card || post.card || null;
        let media = post.media; let error = post.error;
        try { media = await ops.rerenderCard(env, service, { ...post, card }, origin); if (media.length) error = ''; }
        catch (e) { error = '카드 렌더 실패 — ' + String(e.message).slice(0, 120); }
        await d.prepare('UPDATE posts SET hook=?, text=?, hashtags=?, card=?, alt=?, media=?, error=?, updated=? WHERE id=?').bind(gen.hook, gen.text, gen.hashtags.join(' '), card ? JSON.stringify(card) : '', gen.alt || post.alt || '', JSON.stringify(media), error, Date.now(), post.id).run();
        await event(env, sid, 'post.regenerated', gen.hook);
        return ok({ post: await ops.getPost(env, sid, post.id) });
      }
    }
    if (sub === 'sync' && m === 'POST') {
      const r = await ops.collectMetrics(env, sid);
      const daily = await ops.dailySummary(env, sid, { origin });
      return ok({ metrics: r, daily });
    }
    if (sub === 'events' && m === 'GET') return ok({ events: await ops.recentEvents(env, sid, 60) });
  }
  return err(404, 'not_found');
}

async function state(env, space, sid, origin, weekMs = 0) {
  const services = await ops.listServices(env, space);
  const last = (services[services.length - 1] || {}).id;
  const id = isId(sid, 's') && services.some((s) => s.id === sid) ? sid : last; // 없는 주소면 마지막 서비스로
  const caps = { ai: aiReady(env), render: renderReady(env), ig: meta.appReady(env, 'ig'), th: meta.appReady(env, 'th'), media: mediaReady(env), secret: sealReady(env), origin };
  if (!id) return ok({ services, service: null, caps });
  const service = await ops.getService(env, space, id);
  if (!service) return ok({ services, service: null, caps });
  const now = Date.now(); const ws = weekMs > 0 ? weekStart(weekMs) : weekStart(now);
  const [channels, gates, materials, posts, daily, events] = await Promise.all([
    ops.channelsOf(env, id), ops.gatesOf(env, id), ops.materialsOf(env, id),
    ops.postsOf(env, id, ws - 7 * DAY, ws + 21 * DAY), ops.latestDaily(env, id), ops.recentEvents(env, id, 20),
  ]);
  const settings = mergeSettings(service.settings);
  return ok({
    services, caps, now,
    service: { id: service.id, name: service.name, handle: service.handle, homepage: service.homepage, oneliner: service.oneliner, brief: service.brief, bio: service.bio, candidates: service.candidates, created: service.created },
    settings, channels, gates,
    materials: materials.map((mm) => ({ ...mm, url: mm.r2_key ? ops.mediaUrl(origin, mm.r2_key) : mm.url })),
    posts: posts.map((p) => ({ ...p, media: p.media.map((x) => ({ ...x, url: x.r2_key ? ops.mediaUrl(origin, x.r2_key) : x.url })) })),
    signals: signals({ channels, posts, nowMs: now }),
    daily, events,
  });
}

async function oauthCallback(request, env, url, kind, origin) {
  const st = await readState(env, url.searchParams.get('state'));
  const back = (q) => Response.redirect(`${origin}/#${q}`, 302);
  if (!st || st.kind !== kind) return back('oauth=bad_state');
  if (url.searchParams.get('error')) { await event(env, st.serviceId, 'oauth.denied', `${meta.kindName(kind)} — ${url.searchParams.get('error_description') || url.searchParams.get('error')}`, 'warn'); return back(`s=${st.serviceId}&oauth=denied`); }
  const code = url.searchParams.get('code');
  if (!code) return back(`s=${st.serviceId}&oauth=no_code`);
  const d = await db(env);
  const service = await d.prepare('SELECT id FROM services WHERE id=? AND space=?').bind(st.serviceId, st.space).first();
  if (!service) return back('oauth=no_service');
  try {
    const redirectUri = `${origin}/api/oauth/${kind}/callback`;
    const short = await meta.exchangeCode(env, kind, redirectUri, code);
    const long = await meta.longLived(env, kind, short.token);
    const profile = await meta.me(env, kind, long.token);
    if (!profile.id && short.userId) profile.id = short.userId;
    await ops.saveChannel(env, st.serviceId, kind, { token: long.token, expiresAt: long.expiresAt, profile });
    return back(`s=${st.serviceId}&linked=${kind}`);
  } catch (e) {
    await event(env, st.serviceId, 'oauth.failed', `${meta.kindName(kind)} — ${String(e.message).slice(0, 200)}`, 'bad');
    return back(`s=${st.serviceId}&oauth=failed`);
  }
}

// 소재 올리기 — multipart(파일) 또는 json({type:'link'|'text'}). 이미지는 R2 에 두고 /media 로 공개한다.
async function addMaterial(request, env, service, origin) {
  const ct = request.headers.get('content-type') || '';
  if (ct.startsWith('multipart/form-data')) {
    if ((Number(request.headers.get('content-length')) || 0) > 8 * 1024 * 1024) return err(413, 'too_large', { hint: '8MB 까지' });
    if (!mediaReady(env)) return err(503, 'no_media');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err(400, 'file_required');
    const title = String(form.get('title') || file.name || '').slice(0, 80);
    let mime = file.type || ''; let bytes = new Uint8Array(await file.arrayBuffer());
    const isImage = /^image\/(jpeg|png|webp)$/.test(mime);
    const isText = /^text\/(plain|markdown)$/.test(mime) || /\.(md|txt)$/i.test(file.name || '');
    if (!isImage && !isText) return err(415, 'unsupported', { hint: 'JPG·PNG·WebP 이미지 또는 .md/.txt 글만' });
    if (isText) {
      const text = new TextDecoder().decode(bytes).slice(0, 60000);
      const id = await ops.addMaterial(env, service, { type: 'text', title, text, content: text });
      return ok({ id }, 201);
    }
    const sniff = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) ? 'image/webp' : '';
    if (!sniff) return err(415, 'unsupported', { hint: '이미지 파일이 아닙니다(JPG·PNG·WebP 만)' });
    mime = sniff; // 브라우저가 말한 종류가 아니라 실제 바이트로
    if (mime !== 'image/jpeg') { // Instagram 은 JPEG 만 — 바꿀 수 있으면 바꾸고, 못 바꾸면 알린다(조용히 받지 않는다)
      const jpg = await toJpeg(env, bytes, mime);
      if (!jpg) return err(415, 'jpeg_required', { hint: 'Instagram 은 JPG 만 받습니다 — JPG 로 바꿔 올려 주세요(카드 렌더가 켜지면 자동 변환)' });
      bytes = jpg; mime = 'image/jpeg';
    }
    const key = `m/${service.id}/${idFor('i')}.jpg`;
    await putMedia(env, key, bytes, mime);
    const id = await ops.addMaterial(env, service, { type: 'image', title, r2_key: key, mime, content: `이미지 소재: ${title}` });
    return ok({ id, url: ops.mediaUrl(origin, key) }, 201);
  }
  const { body, error } = await readJson(request, 80000); if (error) return err(400, error);
  if (body.type === 'link') {
    let link = String(body.url || '').trim().slice(0, 500);
    if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    let pg;
    try { pg = await ops.fetchPageText(link); } catch (e) { return err(400, 'fetch_failed', { detail: e.message }); }
    const id = await ops.addMaterial(env, service, { type: 'link', title: String(body.title || pg.title || '').slice(0, 80), url: link, content: pg.text });
    return ok({ id }, 201);
  }
  if (body.type === 'text') {
    const text = String(body.text || '').trim().slice(0, 60000);
    if (!text) return err(400, 'text_required');
    const id = await ops.addMaterial(env, service, { type: 'text', title: String(body.title || '').slice(0, 80), text, content: text });
    return ok({ id }, 201);
  }
  return err(400, 'bad_type');
}

export { transition, J };
