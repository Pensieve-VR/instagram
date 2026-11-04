import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { resetReady } from '../lib/db.js';
import { seal } from '../lib/crypto.js';
import * as ops from '../lib/ops.js';

// 크론 → publishOne → Meta(가짜 fetch) 까지. 실제 주소·몸·저장 결과를 본다.
const ORIGIN = 'https://instagram.pensieve.kr';
async function setup({ platform = 'ig', format = 'carousel', media = 2, reply = '' } = {}) {
  resetReady();
  const env = { DB: d1(), SESSION_SECRET: 'a-long-fixed-secret-value-1234', PUBLIC_ORIGIN: ORIGIN, GRAPH_VERSION: 'v26.0', MEDIA: {} };
  await ops.listAccounts(env); // 표 만들기
  const t = Date.now();
  env.DB.raw.prepare("INSERT INTO r_accounts (id,platform,lang,platform_id,username,token_enc,status,created,updated) VALUES ('a1test0001',?,?,?,?,?,?,?,?)")
    .run(platform, 'ko', '1789', 'descartes_works', await seal(env, 'TOKEN-XYZ'), 'linked', t, t);
  const m = Array.from({ length: media }, (_, i) => ({ asset: `fimg00000${i}`, key: `a/fimg00000${i}.jpg`, kind: 'image' }));
  env.DB.raw.prepare(`INSERT INTO r_posts (id,account_id,format,state,scheduled_at,title,caption,hashtags,first_reply,media,created,updated)
    VALUES ('ptest00001','a1test0001',?, 'scheduled', ?, '제목', '본문', '르네 AI펫', ?, ?, ?, ?)`).run(format, t - 1000, reply, JSON.stringify(m), t, t);
  return env;
}
function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const out = handler(u, body, calls.length);
    return new Response(JSON.stringify(out), { status: out && out.error ? 400 : 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const post = (env) => env.DB.raw.prepare("SELECT * FROM r_posts WHERE id='ptest00001'").get();

test('IG 캐러셀 — 크론 한 번에 자식 둘 → 부모 → 게시 → 주소 저장', async () => {
  const env = await setup();
  let n = 0;
  const calls = fakeFetch((u) => {
    if (u.pathname.endsWith('/1789/media')) return { id: 'c' + (++n) };
    if (u.pathname.endsWith('/1789/media_publish')) return { id: 'M1' };
    if (/\/c\d$/.test(u.pathname)) return { status_code: 'FINISHED' };
    if (u.pathname.endsWith('/M1')) return { id: 'M1', permalink: 'https://www.instagram.com/p/abc/' };
    return { error: { message: 'unexpected ' + u.pathname } };
  });
  const out = await ops.publishDue(env, Date.now());
  assert.deepEqual(out.map((o) => o.result), ['posted']);
  const p = post(env);
  assert.equal(p.state, 'posted'); assert.equal(p.platform_post_id, 'M1'); assert.equal(p.permalink, 'https://www.instagram.com/p/abc/');
  const creates = calls.filter((c) => c.path.endsWith('/media'));
  assert.equal(creates[0].body.image_url, `${ORIGIN}/media/a/fimg000000.jpg`);
  assert.equal(creates[0].body.is_carousel_item, 'true');
  assert.equal(creates[0].body.access_token, 'TOKEN-XYZ'); // 봉인을 열어 쓴다
  assert.equal(creates[2].body.media_type, 'CAROUSEL'); assert.equal(creates[2].body.children, 'c1,c2');
  assert.equal(creates[2].body.caption, '본문\n\n#르네 #AI펫');
  assert.ok(calls.every((c) => c.path.startsWith('/v26.0/')));
});

test('토큰 만료(190) → 게시물 실패 · 줄은 만료로', async () => {
  const env = await setup({ format: 'image', media: 1 });
  fakeFetch(() => ({ error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } }));
  await ops.publishDue(env, Date.now());
  assert.equal(post(env).state, 'failed'); assert.match(post(env).error, /토큰 만료/);
  assert.equal(env.DB.raw.prepare("SELECT status FROM r_accounts WHERE id='a1test0001'").get().status, 'expired');
});

test('일시 오류는 두 번까지 이어 가고 세 번째에 실패', async () => {
  const env = await setup({ format: 'image', media: 1 });
  fakeFetch(() => ({ error: { message: 'An unexpected error has occurred', type: 'OAuthException', code: 2 } }));
  for (let i = 0; i < 2; i++) { await ops.publishDue(env, Date.now()); assert.equal(post(env).state, 'publishing'); }
  await ops.publishDue(env, Date.now());
  assert.equal(post(env).state, 'failed'); assert.equal(post(env).attempts, 3);
});

test('Threads 첫 댓글 — 본문 게시 뒤 reply_to_id 로', async () => {
  const env = await setup({ platform: 'th', format: 'text', media: 0, reply: '대기 명단은 프로필 링크' });
  let n = 0;
  const calls = fakeFetch((u) => {
    if (u.pathname.endsWith('/1789/threads')) return { id: 't' + (++n) };
    if (u.pathname.endsWith('/1789/threads_publish')) return { id: 'P' + n };
    if (/\/t\d$/.test(u.pathname)) return { status: 'FINISHED' };
    if (/\/P\d$/.test(u.pathname)) return { id: 'P1', permalink: 'https://www.threads.com/@descartes_works/post/x' };
    return { error: { message: 'unexpected ' + u.pathname } };
  });
  await ops.publishDue(env, Date.now());
  const p = post(env);
  assert.equal(p.state, 'posted'); assert.equal(p.platform_post_id, 'P1');
  const creates = calls.filter((c) => c.path.endsWith('/threads'));
  assert.equal(creates[0].body.media_type, 'TEXT'); assert.equal(creates[0].body.text, '본문'); // Threads 는 해시태그를 붙이지 않는다
  assert.equal(creates[1].body.reply_to_id, 'P1'); assert.equal(creates[1].body.text, '대기 명단은 프로필 링크');
  assert.ok(calls[0].path.startsWith('/v1.0/'));
});

test('같은 게시물을 두 쪽이 동시에 잡으면 한쪽만 진행(busy)', async () => {
  const env = await setup({ format: 'image', media: 1 });
  let n = 0;
  fakeFetch((u) => (u.pathname.endsWith('/media') ? { id: 'c' + (++n) } : u.pathname.endsWith('/media_publish') ? { id: 'M1' } : /\/c\d$/.test(u.pathname) ? { status_code: 'FINISHED' } : { id: 'M1', permalink: '' }));
  const row = await ops.getPost(env, 'ptest00001');
  const r = await Promise.all([ops.publishOne(env, row), ops.publishOne(env, row)]);
  assert.deepEqual(r.sort(), ['busy', 'posted']);
  assert.equal(n, 1); // 컨테이너는 하나만
});

test('승인 시간 지남 → 승인 막힘(422) · 지금 올리기는 시간을 지금으로 바꾸고 올린다', async () => {
  const env = await setup({ format: 'image', media: 1 });
  env.DB.raw.prepare("UPDATE r_posts SET state='review', scheduled_at=? WHERE id='ptest00001'").run(Date.now() - 3600e3);
  await assert.rejects(ops.actPost(env, await ops.getPost(env, 'ptest00001'), 'approve', '영웅'), (e) => e.status === 422);
  let n = 0;
  fakeFetch((u) => (u.pathname.endsWith('/media') ? { id: 'c' + (++n) } : u.pathname.endsWith('/media_publish') ? { id: 'M9' } : /\/c\d$/.test(u.pathname) ? { status_code: 'FINISHED' } : { id: 'M9', permalink: 'x' }));
  const p = await ops.publishNow(env, await ops.getPost(env, 'ptest00001'), '영웅', ORIGIN);
  assert.equal(p.state, 'posted'); assert.equal(p.by, '영웅');
});
