// 르네 콘솔 Worker — 정적 화면(ASSETS) + API + 크론. 길(route)은 아래 api() 하나로 읽는다.
import { login, verify, configured, slow, makeState, readState } from '../lib/auth.js';
import { err, ok, originOk, readJson, publicOrigin } from '../lib/http.js';
import { db, event, isId } from '../lib/db.js';
import { aiReady, DEFAULT_MODEL } from '../lib/ai.js';
import * as meta from '../lib/meta.js';
import * as ops from '../lib/ops.js';
import { renderReady } from '../lib/render.js';
import { sealReady } from '../lib/crypto.js';
import { mediaReady } from '../lib/media.js';
import { DAY, problems, FORMATS } from '../lib/plan.js';

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
      return err(status, status >= 500 && !(e && e.status) ? 'server_error' : e.message, e && e.detail ? { detail: e.detail } : {});
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cron(env, controller.scheduledTime || Date.now()));
  },
};

// 크론 하나(5분). 00:00~00:04 UTC 틱(09:00 KST)은 하루 일(지표·토큰·옛 미디어 정리)도 함께.
export const isDailyTick = (ms) => { const d = new Date(ms); return d.getUTCHours() === 0 && d.getUTCMinutes() < 5; };
async function cron(env, at) {
  try {
    const due = await ops.publishDue(env, at);
    if (due.length) console.log('publishDue', JSON.stringify(due));
    if (isDailyTick(at)) {
      await ops.refreshTokens(env);
      await ops.collectMetrics(env);
      await ops.cleanupOldMedia(env);
    }
  } catch (e) { console.error('cron', e && e.stack || e); }
}

// ---------- 공개 미디어 (Meta·Claude 가 가져간다) — 영상은 Range 도 받는다 ----------
async function media(request, env, url) {
  let key = '';
  try { key = decodeURIComponent(url.pathname.slice('/media/'.length)); } catch { return new Response('not found', { status: 404 }); }
  if (!/^[a-z]\/[A-Za-z0-9._-]+$/.test(key) || !mediaReady(env)) return new Response('not found', { status: 404 });
  const { value, metadata } = await env.MEDIA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!value) return new Response('not found', { status: 404 });
  const type = (metadata && metadata.contentType) || 'application/octet-stream';
  const size = value.byteLength;
  const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' };
  const range = (request.headers.get('range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...h, 'content-range': `bytes */${size}` } });
    const part = value.slice(start, end + 1);
    return new Response(request.method === 'HEAD' ? null : part, { status: 206, headers: { ...h, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(part.byteLength) } });
  }
  return new Response(request.method === 'HEAD' ? null : value, { headers: { ...h, 'content-length': String(size) } });
}

const withUrls = (o, post) => post && ({
  ...post,
  media: post.media.map((m) => ({ ...m, url: m.key ? ops.mediaUrl(o, m.key) : '' })),
});

// ---------- API ----------
async function api(request, env, ctx, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1);
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
  // OAuth 되돌아오기 — 브라우저 리다이렉트라 Authorization 이 없다. state 서명으로 어느 줄인지 안다.
  if (seg[0] === 'oauth' && seg[2] === 'callback' && m === 'GET') return oauthCallback(env, url, seg[1], origin);
  if (seg[0] === 'meta' && meta.KINDS[seg[1]] && (seg[2] === 'uninstall' || seg[2] === 'delete') && m === 'POST') return metaCallback(request, env, seg[1], seg[2], origin);
  if (seg[0] === 'meta' && seg[1] === 'deletion' && m === 'GET') {
    const code = String(url.searchParams.get('code') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    return new Response(code ? `삭제 요청 ${code} — 처리됨. 이 계정의 토큰과 연결 정보는 지워졌습니다.` : '삭제 요청 번호가 없습니다.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  // 여기부터는 열쇠 필요 — 어느 암호든 같은 르네 콘솔(이름은 승인한 사람으로 남긴다)
  const who = await verify(request, env);
  if (!who) return err(401, 'locked');
  if (m !== 'GET' && !originOk(request, env)) return err(403, 'forbidden');
  const by = who.name || '';

  if (seg[0] === 'state' && m === 'GET') {
    const from = Number(url.searchParams.get('from')) || Date.now() - 7 * DAY;
    const to = Math.min(Number(url.searchParams.get('to')) || from + 14 * DAY, from + 62 * DAY);
    const [accounts, posts, assets, brand, wait] = await Promise.all([ops.listAccounts(env), ops.postsIn(env, from, to), ops.listAssets(env), ops.getBrand(env), ops.waiting(env)]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return ok({
      now: Date.now(), from, to, me: by,
      caps: { ai: aiReady(env), render: renderReady(env), media: mediaReady(env), ig: meta.appReady(env, 'ig'), th: meta.appReady(env, 'th'), secret: sealReady(env), mock: env.MOCK_AI === '1' },
      accounts, brand, waiting: wait, formats: FORMATS,
      posts: posts.map((p) => ({ ...withUrls(origin, p), problems: problems(p, byId.get(p.account_id), Date.now()) })),
      assets: assets.map((a) => ({ ...a, url: ops.mediaUrl(origin, a.key) })),
    });
  }
  if (seg[0] === 'events' && m === 'GET') return ok({ events: await ops.recentEvents(env, 60) });

  // 만들기 — 글감 → 계정마다 게시물(Claude)
  if (seg[0] === 'make' && m === 'POST') {
    if (!aiReady(env)) return err(503, 'no_key');
    const { body, error } = await readJson(request, 20000); if (error) return err(400, error);
    return ok(await ops.makeIdea(env, { text: body.text, accountIds: arr(body.accounts), assetIds: arr(body.assets), by, origin }), 201);
  }

  // 게시물
  if (seg[0] === 'posts' && isId(seg[1], 'p')) {
    const post = await ops.getPost(env, seg[1]);
    if (!post) return err(404, 'not_found');
    const out = async (p) => ok({ post: { ...withUrls(origin, p), problems: problems(p, await ops.getAccount(env, p.account_id), Date.now()) } });
    if (m === 'GET' && !seg[2]) return out(post);
    if (m === 'DELETE' && !seg[2]) { await ops.deletePost(env, post); return ok({ deleted: post.id }); }
    if (m === 'POST' && !seg[2]) {
      const { body, error } = await readJson(request, 40000); if (error) return err(400, error);
      if (body.action) return out(await ops.actPost(env, post, String(body.action), by));
      return out(await ops.patchPost(env, post, body));
    }
    if (m === 'POST' && seg[2] === 'revise') {
      if (!aiReady(env)) return err(503, 'no_key');
      const { body, error } = await readJson(request, 4000); if (error) return err(400, error);
      return out(await ops.revisePost(env, post, body.say, origin));
    }
    if (m === 'POST' && seg[2] === 'render') return out(await ops.rerender(env, post, origin));
    if (m === 'POST' && seg[2] === 'now') return out(await ops.publishNow(env, post, by, origin));
  }

  // 소재 — 파일 하나(multipart: file, src, title, w, h). 같은 src·크기면 있던 것을 돌려준다
  if (seg[0] === 'assets') {
    if (m === 'POST' && !seg[1]) return addAsset(request, env, origin);
    if (m === 'DELETE' && isId(seg[1], 'f')) return ok(await ops.deleteAsset(env, seg[1]));
  }
  // 폴더 가져오기 — 묶음들을 한 번에
  if (seg[0] === 'import' && m === 'POST') {
    const { body, error } = await readJson(request, 400000); if (error) return err(400, error);
    return ok(await ops.importPosts(env, arr(body.items), by));
  }

  // 줄(계정)
  if (seg[0] === 'accounts') {
    if (m === 'POST' && !seg[1]) { const { body, error } = await readJson(request, 2000); if (error) return err(400, error); return ok({ account: await ops.addLine(env, body) }, 201); }
    if (m === 'GET' && seg[1] === 'ig-available') return ok(await ops.availableIg(env));
    if (isId(seg[1], 'a')) {
      const acc = await ops.getAccount(env, seg[1]); if (!acc) return err(404, 'not_found');
      if (m === 'POST' && !seg[2]) { const { body, error } = await readJson(request, 2000); if (error) return err(400, error); return ok({ account: await ops.patchAccount(env, acc.id, body) }); }
      if (m === 'DELETE' && !seg[2]) { await ops.removeLine(env, acc.id); return ok({ deleted: acc.id }); }
      if (m === 'POST' && seg[2] === 'unlink') { await ops.unlinkAccount(env, acc.id); return ok({ account: await ops.getAccount(env, acc.id) }); }
      if (m === 'POST' && seg[2] === 'attach-ig') { const { body, error } = await readJson(request, 2000); if (error) return err(400, error); const id = await ops.attachIg(env, acc.id, body.ig_id); return ok({ account: await ops.getAccount(env, id) }); }
      if (m === 'GET' && seg[2] === 'connect') { // OAuth 시작 주소
        const kind = acc.platform;
        if (!meta.KINDS[kind]) return err(501, 'not_yet', { hint: 'X 연결은 2차' });
        if (!meta.appReady(env, kind)) return err(503, 'no_app', { kind });
        if (!sealReady(env)) return err(503, 'no_secret');
        const st = await makeState(env, who.space, acc.id, kind);
        return ok({ url: meta.authUrl(env, kind, `${origin}/api/oauth/${kind}/callback`, st) });
      }
    }
  }
  if (seg[0] === 'brand') {
    if (m === 'GET') return ok({ brand: await ops.getBrand(env) });
    if (m === 'POST') { const { body, error } = await readJson(request, 40000); if (error) return err(400, error); return ok({ brand: await ops.setBrand(env, body) }); }
  }
  if (seg[0] === 'sync' && m === 'POST') return ok({ metrics: await ops.collectMetrics(env) });
  return err(404, 'not_found');
}
const arr = (v) => (Array.isArray(v) ? v : []);

// 몸 = 파일 바이트 그대로(multipart 를 풀지 않아 무료 요금제 CPU 를 아낀다). 이름 등은 머리(x-*, URL 인코딩)로.
async function addAsset(request, env, origin) {
  if ((Number(request.headers.get('content-length')) || 0) > 25 * 1024 * 1024) return err(413, 'too_large', { hint: '25MB 까지' });
  if (!mediaReady(env)) return err(503, 'no_media');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) return err(400, 'file_required');
  if (bytes.byteLength > 25 * 1024 * 1024) return err(413, 'too_large', { hint: '25MB 까지' });
  // 브라우저가 말한 종류가 아니라 실제 바이트로
  const sniff = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
      : String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp' ? (/qt/.test(String.fromCharCode(bytes[8], bytes[9])) ? 'video/quicktime' : 'video/mp4') : '';
  if (!sniff) return err(415, 'unsupported', { hint: 'JPG·PNG 사진, MP4 영상만' });
  const hv = (k) => { try { return decodeURIComponent(request.headers.get(k) || ''); } catch { return ''; } };
  const src = hv('x-src').slice(0, 400);
  const found = await ops.findAsset(env, src, bytes.byteLength);
  if (found) return ok({ asset: { ...found, url: ops.mediaUrl(origin, found.key) }, reused: true });
  const a = await ops.addAsset(env, { bytes, mime: sniff, kind: sniff.startsWith('video') ? 'video' : 'image', w: hv('x-w'), h: hv('x-h'), title: hv('x-title'), src });
  return ok({ asset: { ...a, url: ops.mediaUrl(origin, a.key) } }, 201);
}

async function oauthCallback(env, url, kind, origin) {
  const st = await readState(env, url.searchParams.get('state'));
  const back = (q) => Response.redirect(`${origin}/#${q}`, 302);
  if (!st || st.kind !== kind) return back('oauth=bad_state');
  if (url.searchParams.get('error')) { await event(env, 'oauth.denied', `${meta.kindName(kind)} — ${url.searchParams.get('error_description') || url.searchParams.get('error')}`, 'warn'); return back('oauth=denied'); }
  const code = url.searchParams.get('code');
  if (!code) return back('oauth=no_code');
  const acc = await ops.getAccount(env, st.serviceId);
  if (!acc) return back('oauth=no_line');
  try {
    const redirectUri = `${origin}/api/oauth/${kind}/callback`;
    const short = await meta.exchangeCode(env, kind, redirectUri, code);
    const long = await meta.longLived(env, kind, short);
    let igId = '';
    if (kind === 'ig') {
      const list = await meta.igAccounts(env, long.token);
      const d = await db(env);
      const { results } = await d.prepare("SELECT platform_id FROM r_accounts WHERE platform='ig' AND platform_id<>'' AND id<>?").bind(acc.id).all();
      const used = new Set(results.map((r) => r.platform_id));
      const pick = list.find((a) => acc.username && a.username.toLowerCase() === acc.username.toLowerCase()) || list.find((a) => !used.has(a.id)) || list[0];
      if (!pick) throw new Error('로그인에서 고른 Instagram 계정이 없다 — 연결할 때 계정을 체크해 주세요');
      igId = pick.id;
    }
    const profile = await meta.me(env, kind, long.token, igId);
    if (!profile.id && short.userId) profile.id = short.userId;
    await ops.saveLink(env, acc.id, kind, { token: long.token, expiresAt: long.expiresAt, profile });
    return back(`linked=${kind}`);
  } catch (e) {
    await event(env, 'oauth.failed', `${meta.kindName(kind)} — ${String(e.message).slice(0, 200)}`, 'bad');
    return back('oauth=failed');
  }
}

async function metaCallback(request, env, kind, what, origin) {
  let signed = '';
  try { const form = await request.formData(); signed = String(form.get('signed_request') || ''); } catch { signed = ''; }
  const payload = await meta.parseSignedRequest(meta.appCreds(env, kind).secret, signed);
  if (!payload) return err(400, 'bad_signed_request');
  const uid = String(payload.user_id || payload.profile_id || '');
  const n = uid ? await ops.forgetAccount(env, kind, uid, what) : 0;
  if (what === 'uninstall') return ok({ ok: true, accounts: n });
  const code = `${kind}${Date.now().toString(36)}`;
  return ok({ url: `${origin}/api/meta/deletion?code=${code}`, confirmation_code: code });
}
