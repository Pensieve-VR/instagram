import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { resetReady } from '../lib/db.js';
import { seal } from '../lib/crypto.js';
import { createHmac } from 'node:crypto';
import { normalizeDm, matches, slugOf, linkFor, fill, runDm, getDm, setDm, dmOverview, handleHook, hookToken, hookVerify, hookSignatureOk } from '../lib/dm.js';

const KW = { ko: '르네', en: 'RENE' };
const S = normalizeDm({});

test('matches — 브랜드 키워드·더한 말·번호(1~4)만', () => {
  assert.ok(matches('르네!!', S, KW));
  assert.ok(matches('저도 르네 주세요', S, KW));
  assert.ok(matches('RENE please', S, KW));
  assert.ok(matches('rené', S, KW)); // 악센트는 같은 글자로
  assert.ok(matches('링크요', S, KW));
  assert.ok(matches('2', S, KW));
  assert.ok(matches('저는 3번!', S, KW));
  assert.ok(!matches('와 귀엽다', S, KW));
  assert.ok(!matches('5', S, KW));
  assert.ok(!matches('1000원이면 사요', S, KW));
  assert.ok(!matches('', S, KW));
  assert.ok(!matches('2', normalizeDm({ numbers: false }), KW));
  assert.ok(matches('구매각', normalizeDm({ words: '구매, 살래' }), KW));
});

test('slugOf · linkFor — 어느 글에서 왔는지 src 로', () => {
  assert.equal(slugOf({ src: '인스타/05_피드_P1_나만의AI펫' }), 'p1');
  assert.equal(slugOf({ src: '영어/인스타_EN/04_릴스_R2_탭지옥' }), 'r2');
  assert.equal(slugOf({ src: '인스타/01_고정_오른쪽_먼저' }), 'pin01');
  assert.equal(slugOf({ id: 'pabcdef123456', src: '' }), 'x123456');
  assert.equal(slugOf(null, '17912345678901234'), 'm901234');
  assert.equal(linkFor('ko', 'p1', 'https://www.pensieve.kr/early'), 'https://www.pensieve.kr/r/ig_dm_p1');
  assert.equal(linkFor('en', 'pin01', 'https://www.pensieve.kr/early'), 'https://www.pensieve.kr/r/en_ig_dm_pin01');
  assert.equal(linkFor('ko', 'p1', 'https://example.com/join'), 'https://example.com/join?src=ig_dm_p1');
  assert.equal(fill('여기 → {link} / {링크}', 'https://x.y'), '여기 → https://x.y / https://x.y');
});

test('normalizeDm — 빈 값은 기본, 길이 제한, 공개 답글은 줄마다', () => {
  const d = normalizeDm({ on: false, text: { ko: '  ' }, replies: { ko: '하나\n\n둘\n' } });
  assert.equal(d.on, false);
  assert.match(d.text.ko, /\{link\}/); // 비우면 기본 문구
  assert.deepEqual(d.replies.ko, ['하나', '둘']);
  assert.ok(normalizeDm({ text: { ko: 'x'.repeat(5000) } }).text.ko.length <= 900);
  assert.equal(normalizeDm({ text: { ko: '링크 없음' } }).text.ko, '링크 없음\n{link}'); // 링크 자리가 없으면 끝에 붙인다
});

// ---------- 크론 한 번(가짜 Meta) ----------
const IG = '1789';
async function setup({ on = true } = {}) {
  resetReady();
  const env = { DB: d1(), SESSION_SECRET: 'a-long-fixed-secret-value-1234', GRAPH_VERSION: 'v26.0', IG_APP_ID: '111', IG_APP_SECRET: 'sec' };
  await getDm(env);
  const t = Date.now();
  env.DB.raw.prepare("INSERT INTO r_accounts (id,platform,lang,platform_id,username,token_enc,status,created,updated) VALUES ('a1test0001','ig','ko',?,?,?,?,?,?)")
    .run(IG, 'descartes_works', await seal(env, 'TOKEN-XYZ'), 'linked', t, t);
  env.DB.raw.prepare("INSERT INTO r_posts (id,account_id,format,state,title,src,platform_post_id,created,updated) VALUES ('ppost00001','a1test0001','carousel','posted','P1','인스타/05_피드_P1_나만의AI펫','M1',?,?)").run(t, t);
  if (!on) await setDm(env, { on: false });
  return env;
}
function meta(state) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    let body = null;
    if (init.body) { try { body = JSON.parse(String(init.body)); } catch { body = Object.fromEntries(new URLSearchParams(String(init.body))); } }
    const c = { method: init.method || 'GET', path: u.pathname.replace('/v26.0', ''), query: Object.fromEntries(u.searchParams), body, auth: (init.headers && (init.headers.authorization || init.headers.Authorization)) || '' };
    calls.push(c);
    const out = state.handle(c);
    return new Response(JSON.stringify(out), { status: out && out.error ? (out.status || 400) : 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+0000');
const rows = (env) => env.DB.raw.prepare('SELECT * FROM r_dm ORDER BY created').all();

function world(t0) {
  const W = {
    media: [{ id: 'M1', comments_count: 0 }],
    comments: { M1: [] },
    convs: [],
    fail: null,
    handle(c) {
      if (W.fail && W.fail(c)) return W.fail(c);
      if (c.path === `/${IG}/media`) return { data: W.media };
      const m = c.path.match(/^\/(M\d)\/comments$/); if (m) return { data: W.comments[m[1]] || [] };
      if (c.path === `/${IG}/messages`) return { recipient_id: 'u', message_id: 'mid' + calls.length };
      if (/^\/c\d+\/replies$/.test(c.path)) return { id: 'r' + calls.length };
      if (c.path === `/${IG}/conversations`) return { data: W.convs };
      return { error: { message: 'unexpected ' + c.path } };
    },
  };
  const calls = meta(W);
  W.calls = calls;
  W.t0 = t0;
  return W;
}
const cm = (id, text, ms, user = 'fan1', uid = 'U1') => ({ id, text, timestamp: iso(ms), username: user, from: { id: uid, username: user } });

test('처음 켜면 지난 7일 안 댓글까지 보낸다 — 그보다 오래된 건 Meta 가 막아 건너뛴다', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  W.media = [{ id: 'M1', comments_count: 2 }];
  W.comments.M1 = [cm('c0', '르네', t0 - 8 * 86400e3, 'old', 'U0'), cm('c1', '르네', t0 - 3600e3)];
  await runDm(env, { now: t0 });
  const sends = W.calls.filter((c) => c.path === `/${IG}/messages`);
  assert.deepEqual(sends.map((c) => c.body.recipient.comment_id), ['c1']);
  // 다음 틱 — 숫자가 그대로면 댓글을 다시 읽지 않는다
  const n = W.calls.filter((c) => c.path.endsWith('/comments')).length;
  await runDm(env, { now: t0 + 20e3 });
  assert.equal(W.calls.filter((c) => c.path.endsWith('/comments')).length, n);
});

test('키워드 댓글 → 비공개 답장 DM(링크) + 공개 답글 · 같은 사람이 또 달면 또 보낸다', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  W.media = [{ id: 'M1', comments_count: 4 }];
  W.comments.M1 = [
    cm('c1', '르네', t0 + 10e3),
    cm('c2', '귀엽다', t0 + 11e3, 'fan2', 'U2'),
    cm('c3', '저도 르네요', t0 + 12e3), // 같은 사람(U1) 이 또
    cm('c4', '르네', t0 + 13e3, 'descartes_works', 'OWN'), // 우리 계정
  ];
  const out = await runDm(env, { now: t0 + 20e3 });
  const sends = W.calls.filter((c) => c.path === `/${IG}/messages`);
  assert.deepEqual(sends.map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
  assert.match(sends[0].body.message.text, /https:\/\/www\.pensieve\.kr\/r\/ig_dm_p1/);
  assert.equal(sends[0].auth, 'Bearer TOKEN-XYZ');
  const replies = W.calls.filter((c) => c.path === '/c1/replies');
  assert.equal(replies.length, 1);
  assert.ok(S.replies.ko.includes(replies[0].body.message));
  const r = rows(env);
  assert.deepEqual(r.map((x) => [x.id, x.state]), [['c:c1', 'sent'], ['c:c3', 'sent']]);
  assert.equal(r[0].link, 'https://www.pensieve.kr/r/ig_dm_p1');
  assert.equal(out.sent, 2);
  // 다시 읽어도 같은 댓글엔 두 번 보내지 않는다
  W.media = [{ id: 'M1', comments_count: 5 }];
  await runDm(env, { now: t0 + 40e3 });
  assert.equal(W.calls.filter((c) => c.path === `/${IG}/messages`).length, 2);
});

test('꺼 두면 Meta 를 부르지도 않고, 다시 켜면 그동안 못 보낸 것까지(7일 안) 보낸다', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  W.media = [{ id: 'M1', comments_count: 1 }];
  W.comments.M1 = [cm('c1', '르네', t0 + 5e3)];
  await setDm(env, { on: false });
  const before = W.calls.length;
  await runDm(env, { now: t0 + 60e3 });
  assert.equal(W.calls.length, before);
  await setDm(env, { on: true });
  await runDm(env, { now: t0 + 120e3 });
  assert.deepEqual(W.calls.filter((c) => c.path === `/${IG}/messages`).map((c) => c.body.recipient.comment_id), ['c1']);
});

test('댓글 뒤 7일이 지나면 보내지 않는다(비공개 답장 창)', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  W.media = [{ id: 'M1', comments_count: 1 }];
  W.comments.M1 = [cm('c1', '르네', t0 + 5e3)];
  await runDm(env, { now: t0 + 8 * 86400e3 });
  assert.equal(W.calls.filter((c) => c.path === `/${IG}/messages`).length, 0);
});

test('권한 오류 → 잠시 멈추고, 그 댓글은 나중에 다시(권한을 고치면 보낸다)', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  W.media = [{ id: 'M1', comments_count: 1 }];
  W.comments.M1 = [cm('c1', '르네', t0 + 5e3)];
  W.fail = (c) => (c.path === `/${IG}/messages` ? { error: { message: '(#200) Requires instagram_manage_messages permission', code: 200, type: 'OAuthException' } } : null);
  await runDm(env, { now: t0 + 60e3 });
  assert.equal(rows(env)[0].state, 'retry');
  const st = (await dmOverview(env)).accounts[0];
  assert.match(st.error, /instagram_manage_messages/);
  assert.ok(st.pausedUntil > t0 + 60e3);
  // 멈춘 동안은 부르지 않는다
  const before = W.calls.length;
  await runDm(env, { now: t0 + 120e3 });
  assert.equal(W.calls.length, before);
  // 권한을 고친 뒤 — 같은 댓글에 보낸다
  W.fail = null;
  await runDm(env, { now: t0 + 40 * 60e3 });
  assert.equal(rows(env)[0].state, 'sent');
  assert.equal((await dmOverview(env)).accounts[0].error, '');
});

test('한 틱 외부 호출 한도를 지킨다', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  W.media = [{ id: 'M1', comments_count: 30 }];
  W.comments.M1 = Array.from({ length: 30 }, (_, i) => cm('c' + (i + 1), '르네', t0 + 1000 + i, 'f' + i, 'U' + i));
  W.calls.length = 0;
  await runDm(env, { now: t0 + 60e3, budget: 9 });
  assert.ok(W.calls.length <= 9, `calls ${W.calls.length}`);
  const sent = rows(env).filter((r) => r.state === 'sent').length;
  assert.ok(sent >= 3);
  // 남은 건 다음 틱에
  await runDm(env, { now: t0 + 120e3, budget: 200 });
  assert.equal(rows(env).filter((r) => r.state === 'sent').length, 30);
  assert.equal(new Set(W.calls.filter((c) => c.path === `/${IG}/messages`).map((c) => c.body.recipient.comment_id)).size, 30, '같은 댓글에 두 번 보내지 않는다');
});

test('스토리 답장·DM 에 키워드 → 그 사람에게 링크(우리 메시지·예전 메시지는 무시)', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  const msg = (id, text, ms, from) => ({ id, message: text, created_time: iso(ms), from });
  W.convs = [
    { id: 'cv1', updated_time: iso(t0 + 9e3), messages: { data: [msg('m2', '르네', t0 + 9e3, { id: 'U9', username: 'fan9' }), msg('m1', '안녕', t0 + 8e3, { id: 'U9', username: 'fan9' })] } },
    { id: 'cv2', updated_time: iso(t0 + 7e3), messages: { data: [msg('m3', '르네예요 여기 → https://www.pensieve.kr/r/ig_dm_msg', t0 + 7e3, { id: 'X', username: 'descartes_works' })] } },
    { id: 'cv3', updated_time: iso(t0 - 30 * 3600e3), messages: { data: [msg('m4', '르네', t0 - 30 * 3600e3, { id: 'U8', username: 'old' })] } }, // 24시간 창 밖
    { id: 'cv4', updated_time: iso(t0 + 6e3), messages: { data: [msg('m5', '2', t0 + 6e3, { id: 'U7', username: 'fan7' })] } }, // DM 의 번호는 키워드가 아니다
  ];
  await runDm(env, { now: t0 + 60e3 });
  const sends = W.calls.filter((c) => c.path === `/${IG}/messages`);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].body.recipient, { id: 'U9' });
  assert.match(sends[0].body.message.text, /r\/ig_dm_msg/);
  const conv = W.calls.find((c) => c.path === `/${IG}/conversations`);
  assert.equal(conv.query.platform, 'instagram');
  await runDm(env, { now: t0 + 120e3 });
  assert.equal(W.calls.filter((c) => c.path === `/${IG}/messages`).length, 1, '같은 메시지엔 한 번');
});

test('메시지 읽기가 막히면 댓글은 계속 — 메시지만 쉰다', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await runDm(env, { now: t0 });
  W.fail = (c) => (c.path === `/${IG}/conversations` ? { error: { message: 'Unsupported get request', code: 100 } } : null);
  W.media = [{ id: 'M1', comments_count: 1 }];
  W.comments.M1 = [cm('c1', '르네', t0 + 5e3)];
  await runDm(env, { now: t0 + 60e3 });
  assert.equal(rows(env)[0].state, 'sent');
  const st = (await dmOverview(env)).accounts[0];
  assert.match(st.msgError, /Unsupported/);
  const n = W.calls.filter((c) => c.path === `/${IG}/conversations`).length;
  await runDm(env, { now: t0 + 120e3 });
  assert.equal(W.calls.filter((c) => c.path === `/${IG}/conversations`).length, n, '메시지는 한동안 다시 묻지 않는다');
});

// ---------- 웹훅 ----------
const commentHook = (id, text, from, media = 'M1', t = Date.now()) => ({ object: 'instagram', entry: [{ id: IG, time: Math.floor(t / 1000), changes: [{ field: 'comments', value: { id, text, from, media: { id: media } } }] }] });

test('웹훅 확인 — 토큰이 맞을 때만 challenge · 서명은 앱 시크릿 HMAC', async () => {
  const env = await setup();
  const tk = await hookToken(env);
  assert.match(tk, /^rene-[A-Za-z0-9_-]{24}$/);
  const u = (t) => new URL(`https://x/api/meta/ig/webhook?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=4242`);
  assert.equal(await hookVerify(env, u(tk)), '4242');
  assert.equal(await hookVerify(env, u('nope')), null);
  const raw = JSON.stringify(commentHook('c1', '르네', { id: 'U1', username: 'a' }));
  const sig = 'sha256=' + createHmac('sha256', 'sec').update(raw).digest('hex');
  assert.equal(await hookSignatureOk(env, raw, sig), true);
  assert.equal(await hookSignatureOk(env, raw + ' ', sig), false);
  assert.equal(await hookSignatureOk(env, raw, ''), false);
});

test('웹훅 댓글 → 바로 DM · 크론이 나중에 봐도 두 번 안 보낸다', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  await handleHook(env, commentHook('c9', '르네 주세요', { id: 'U5', username: 'fan5' }, 'M1', t0), t0);
  const sends = W.calls.filter((c) => c.path === `/${IG}/messages`);
  assert.deepEqual(sends.map((c) => c.body.recipient), [{ comment_id: 'c9' }]);
  assert.match(sends[0].body.message.text, /ig_dm_p1/);
  assert.equal(W.calls.filter((c) => c.path === '/c9/replies').length, 1);
  W.media = [{ id: 'M1', comments_count: 1 }]; W.comments.M1 = [cm('c9', '르네 주세요', t0, 'fan5', 'U5')];
  await runDm(env, { now: t0 + 20e3 });
  assert.equal(W.calls.filter((c) => c.path === `/${IG}/messages`).length, 1);
  // 우리 답글(같은 계정)·키워드 없는 댓글은 지나간다
  await handleHook(env, commentHook('c10', '르네', { id: IG, username: 'descartes_works' }), t0);
  await handleHook(env, commentHook('c11', '예쁘다', { id: 'U6', username: 'fan6' }), t0);
  assert.equal(W.calls.filter((c) => c.path === `/${IG}/messages`).length, 1);
});

test('웹훅 메시지(스토리 답장) → 바로 링크 · 우리가 보낸 메아리는 무시 · 꺼져 있으면 아무것도', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  const msgHook = (mid, text, sender, echo = false) => ({ object: 'instagram', entry: [{ id: IG, time: Math.floor(t0 / 1000), messaging: [{ sender: { id: sender }, recipient: { id: IG }, timestamp: t0, message: { mid, text, ...(echo ? { is_echo: true } : {}), reply_to: { story: { id: 'st1' } } } }] }] });
  await handleHook(env, msgHook('mid1', '르네', 'U7'), t0);
  await handleHook(env, msgHook('mid2', '르네예요 → https://www.pensieve.kr/r/ig_dm_msg', IG, true), t0);
  await handleHook(env, msgHook('mid1', '르네', 'U7'), t0); // 같은 알림이 또 와도
  const sends = W.calls.filter((c) => c.path === `/${IG}/messages`);
  assert.deepEqual(sends.map((c) => c.body.recipient), [{ id: 'U7' }]);
  await setDm(env, { on: false });
  const n = W.calls.length;
  await handleHook(env, msgHook('mid3', '르네', 'U8'), t0);
  assert.equal(W.calls.length, n);
});

test('Worker 길 — GET 확인 · 서명 틀리면 403 · 맞으면 200 뒤에 처리', async () => {
  const env = await setup();
  const t0 = Date.now();
  const W = world(t0);
  const worker = (await import('../src/index.js')).default;
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const tk = await hookToken(env);
  const g = await worker.fetch(new Request(`https://instagram.pensieve.kr/api/meta/ig/webhook?hub.mode=subscribe&hub.verify_token=${tk}&hub.challenge=77`), env, ctx);
  assert.equal(g.status, 200); assert.equal(await g.text(), '77');
  const raw = JSON.stringify(commentHook('c20', '르네', { id: 'U9', username: 'fan9' }));
  const bad = await worker.fetch(new Request('https://instagram.pensieve.kr/api/meta/ig/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } }), env, ctx);
  assert.equal(bad.status, 403);
  const good = await worker.fetch(new Request('https://instagram.pensieve.kr/api/meta/ig/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'sec').update(raw).digest('hex') } }), env, ctx);
  assert.equal(good.status, 200);
  await Promise.all(waits);
  assert.deepEqual(W.calls.filter((c) => c.path === `/${IG}/messages`).map((c) => c.body.recipient), [{ comment_id: 'c20' }]);
});
