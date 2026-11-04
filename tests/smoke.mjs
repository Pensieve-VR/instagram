// 연기 시험 — 로컬 wrangler dev(MOCK_AI=1, PASSWORDS=나=test) 를 상대로 콘솔 흐름 전체를 한 번 돈다.
//   npm run dev  (다른 터미널)  →  node tests/smoke.mjs [http://127.0.0.1:8787]
// 로컬엔 Browser Rendering·Meta 가 없다 → 카드는 「다시 찍기」로 남고, 게시는 「연결 전」으로 막히는지까지 본다.
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const ORIGIN = new URL(BASE).origin;
let token = '';
const h = (extra = {}) => ({ origin: ORIGIN, ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra });
async function j(method, path, body, extra = {}) {
  const init = { method, headers: h(extra) };
  if (body instanceof FormData) init.body = body; else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, init);
  let data = null; try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}
const step = (name) => process.stdout.write(`· ${name}\n`);
// 1×1 JPEG
const JPG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='), (c) => c.charCodeAt(0));
const upload = async (name, src, bytes = JPG, type = 'image/jpeg') => {
  const r = await fetch(BASE + '/api/assets', { method: 'POST', headers: h({ 'content-type': type, 'x-src': encodeURIComponent(src), 'x-title': encodeURIComponent(name) }), body: bytes });
  let data = null; try { data = await r.json(); } catch { data = null; } return { status: r.status, data };
};

step('health');
{ const { status, data } = await j('GET', '/api/health'); assert.equal(status, 200); assert.equal(data.mock, true); }

step('잠금 · 틀린 암호 · 남의 origin · 맞는 암호');
{ assert.equal((await j('GET', '/api/state')).status, 401);
  assert.equal((await j('POST', '/api/login', { password: 'nope' })).status, 401);
  const bad = await fetch(BASE + '/api/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test' }) }); assert.equal(bad.status, 403);
  const r = await j('POST', '/api/login', { password: 'test' }); assert.equal(r.status, 200); token = r.data.token; }

let st;
step('state — 처음엔 점선 줄 다섯(IG KO · TH KO · IG EN · TH EN · X)');
{ const r = await j('GET', '/api/state'); assert.equal(r.status, 200); st = r.data;
  const lines = st.accounts.map((a) => `${a.platform}-${a.lang}`);
  for (const l of ['ig-ko', 'th-ko', 'ig-en', 'th-en', 'x-en']) assert.ok(lines.includes(l), l);
  assert.ok(st.brand.facts.length > 3); }
const line = (p, l) => st.accounts.find((a) => a.platform === p && a.lang === l);

step('지난 시험 찌꺼기 치우기');
{ for (const p of st.posts) await j('DELETE', `/api/posts/${p.id}`);
  for (const a of st.assets.filter((x) => /^smoke\/|^card$/.test(x.src))) await j('DELETE', `/api/assets/${a.id}`); }

step('소재 올리기 · 같은 src 는 다시 쓰기 · 사진 아닌 것은 거절');
let photo;
{ const a = await upload('p.jpg', 'smoke/p.jpg'); assert.equal(a.status, 201); photo = a.data.asset; assert.match(photo.key, /^a\/f[a-z0-9]+\.jpg$/);
  const b = await upload('p.jpg', 'smoke/p.jpg'); assert.equal(b.status, 200); assert.equal(b.data.reused, true); assert.equal(b.data.asset.id, photo.id);
  const c = await upload('x.txt', 'smoke/x.txt', new TextEncoder().encode('hello'), 'text/plain'); assert.equal(c.status, 415);
  const m = await fetch(`${BASE}/media/${photo.key}`); assert.equal(m.status, 200); assert.equal(m.headers.get('content-type'), 'image/jpeg');
  const rg = await fetch(`${BASE}/media/${photo.key}`, { headers: { range: 'bytes=0-9' } }); assert.equal(rg.status, 206); assert.equal((await rg.arrayBuffer()).byteLength, 10); }

step('만들기 — 글감 → IG KO 캐러셀 + TH KO 사진 글, 같은 글감');
let made;
{ const r = await j('POST', '/api/make', { text: '르네가 종이를 보고 말해 준다', accounts: [line('ig', 'ko').id, line('th', 'ko').id], assets: [photo.id] });
  assert.equal(r.status, 201, JSON.stringify(r.data)); made = r.data; assert.equal(made.posts.length, 2);
  const s = (await j('GET', '/api/state')).data;
  const mine = s.posts.filter((p) => made.posts.includes(p.id));
  assert.equal(mine.length, 2); assert.ok(mine.every((p) => p.state === 'review' && p.idea_id === made.idea));
  const ig = mine.find((p) => p.account_id === line('ig', 'ko').id);
  assert.equal(ig.format, 'carousel'); assert.equal(ig.media.length, 3);
  assert.ok(ig.problems.some((x) => /연결/.test(x))); // 로컬엔 연결이 없다
  assert.equal(s.waiting.review >= 2, true); }

step('승인은 문제(연결 전)가 있으면 422 와 이유');
{ const r = await j('POST', `/api/posts/${made.posts[0]}`, { action: 'approve' }); assert.equal(r.status, 422); assert.ok(Array.isArray(r.data.detail)); }

step('고치기 — 글·시간·해시태그 · 한 마디로 고치기(mock)');
{ const at = Date.now() + 3 * 86400e3;
  const r = await j('POST', `/api/posts/${made.posts[0]}`, { caption: '새 글', hashtags: '#르네 AI펫', scheduled_at: at });
  assert.equal(r.status, 200); assert.equal(r.data.post.caption, '새 글'); assert.equal(r.data.post.hashtags, '르네 AI펫'); assert.equal(r.data.post.scheduled_at, at);
  const v = await j('POST', `/api/posts/${made.posts[0]}/revise`, { say: '더 짧게' }); assert.equal(v.status, 200); assert.match(v.data.post.caption, /고침/); }

step('건너뛰기 → 되살리기 · 없는 행동은 409');
{ assert.equal((await j('POST', `/api/posts/${made.posts[1]}`, { action: 'skip' })).data.post.state, 'skipped');
  assert.equal((await j('POST', `/api/posts/${made.posts[1]}`, { action: 'restore' })).data.post.state, 'review');
  assert.equal((await j('POST', `/api/posts/${made.posts[1]}`, { action: 'retry' })).status, 409); }

step('폴더 가져오기 — 같은 묶음 이름은 같은 글감, 같은 src 는 두 번 안 만든다');
{ const a1 = (await upload('1.jpg', 'smoke/인스타/01_고정/1.jpg', Uint8Array.from([...JPG, 1]))).data.asset;
  const a2 = (await upload('2.jpg', 'smoke/인스타/01_고정/2.jpg', Uint8Array.from([...JPG, 2]))).data.asset;
  const items = [
    { account_id: line('ig', 'ko').id, format: 'carousel', title: '고정 1', caption: '본문\n\n#르네 #AI펫', media: [a1.id, a2.id], src: 'smoke/인스타/01_고정', pinned: true, group: '고정 1' },
    { account_id: line('ig', 'en').id, format: 'carousel', title: '고정 1', caption: 'Body', media: [a1.id, a2.id], src: 'smoke/영어/인스타_EN/01_고정', pinned: true, group: '고정 1' },
    { account_id: line('th', 'ko').id, format: 'story', title: '잘못된 형식', media: [a1.id], src: 'smoke/x' },
  ];
  const r = await j('POST', '/api/import', { items }); assert.equal(r.status, 200); assert.equal(r.data.made, 2); assert.equal(r.data.skipped, 1);
  const again = await j('POST', '/api/import', { items }); assert.equal(again.data.made, 0);
  const s = (await j('GET', '/api/state', undefined)).data;
  const imp = s.posts.filter((p) => p.src && p.src.startsWith('smoke/'));
  assert.equal(imp.length, 2); assert.equal(imp[0].idea_id, imp[1].idea_id); assert.ok(imp[0].idea_id);
  const ko = imp.find((p) => p.account_id === line('ig', 'ko').id); assert.equal(ko.caption, '본문'); assert.equal(ko.hashtags, '르네 AI펫'); }

step('소재 지우기 → 쓰던 게시물에서 장이 빠지고 「내 차례」로');
{ const s0 = (await j('GET', '/api/state')).data;
  const p = s0.posts.find((x) => x.src === 'smoke/인스타/01_고정');
  const r = await j('DELETE', `/api/assets/${p.media[0].asset}`); assert.equal(r.status, 200); assert.ok(r.data.detached >= 1);
  const after = (await j('GET', `/api/posts/${p.id}`)).data.post; assert.equal(after.media.length, 1); }

step('줄 — 더하기 · 시간대 · 지우기 · X 연결은 2차');
{ const r = await j('POST', '/api/accounts', { platform: 'th', lang: 'en' }); assert.equal(r.status, 201); const id = r.data.account.id;
  assert.equal((await j('POST', `/api/accounts/${id}`, { slot: '07:30' })).data.account.slot, '07:30');
  assert.equal((await j('POST', `/api/accounts/${id}`, { slot: '25:00' })).status, 400);
  assert.equal((await j('DELETE', `/api/accounts/${id}`)).status, 200);
  assert.equal((await j('GET', `/api/accounts/${line('x', 'en').id}/connect`)).status, 501); }

step('브랜드 시트 저장');
{ const b = (await j('GET', '/api/brand')).data.brand; const r = await j('POST', '/api/brand', { ...b, facts: [...b.facts, '시험용 사실'] });
  assert.equal(r.status, 200); assert.ok(r.data.brand.facts.includes('시험용 사실'));
  await j('POST', '/api/brand', b); }

step('대기 명단 — 홈페이지 출처만 · 순번 · 통계 · 관리 요약·CSV · 지우기');
{ const W = 'https://www.pensieve.kr';
  const pre = await fetch(BASE + '/api/waitlist', { method: 'OPTIONS', headers: { origin: W, 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), W);
  const body = { email: 'smoke@example.com', src: 'smoke', lang: 'ko', color: 'doze', bundle: 'solo', privacy: true, ad: true };
  const evil = await fetch(BASE + '/api/waitlist', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(evil.status, 403);
  const send = (b) => fetch(BASE + '/api/waitlist', { method: 'POST', headers: { origin: W, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const r1 = await send(body); assert.equal(r1.status, 200); assert.equal(r1.headers.get('access-control-allow-origin'), W);
  const j1 = await r1.json(); assert.ok(j1.position >= 1);
  const r2 = await (await send({ ...body, email: 'SMOKE@example.com' })).json(); assert.equal(r2.already, true); assert.equal(r2.position, j1.position);
  assert.equal((await send({ ...body, privacy: false })).status, 400);
  const st = await (await fetch(BASE + '/api/waitlist/stats')).json(); assert.ok(st.count >= 1 && st.cap >= 1);
  assert.equal((await j('GET', '/api/waitlist/admin', undefined, {})).status, 200);
  const sum = (await j('GET', '/api/waitlist/admin')).data; assert.ok(sum.bySrc.some((x) => x.key === 'smoke'));
  const csv = await (await fetch(BASE + '/api/waitlist/admin.csv', { headers: h() })).text(); assert.match(csv, /smoke@example\.com/);
  const un = await fetch(BASE + '/api/waitlist/admin', { headers: { origin: ORIGIN } }); assert.equal(un.status, 401); // 열쇠 없이는 관리 못 봄
  assert.equal((await j('DELETE', '/api/waitlist/admin?email=smoke@example.com')).data.removed, 1); }

step('자동 DM — 설정 저장·되돌리기 · 상태 · 권한 점검 · 지금 확인(연결 없음)');
{ const un = await fetch(BASE + '/api/dm', { headers: { origin: ORIGIN } }); assert.equal(un.status, 401);
  const o = (await j('GET', '/api/dm')).data; assert.equal(typeof o.settings.on, 'boolean'); assert.ok(Array.isArray(o.recent));
  const r = await j('POST', '/api/dm', { words: '시험, smoke', replies: { ko: '' } });
  assert.equal(r.status, 200); assert.equal(r.data.settings.words, '시험, smoke'); assert.deepEqual(r.data.settings.replies.ko, []);
  assert.match(r.data.settings.text.ko, /\{link\}/);
  assert.equal((await j('GET', '/api/dm/check')).status, 200);
  const run = await j('POST', '/api/dm/run', {}); assert.equal(run.status, 200); assert.equal(run.data.run.sent, 0);
  await j('POST', '/api/dm', o.settings); }

step('치우기');
{ const s = (await j('GET', '/api/state', undefined)).data;
  for (const p of s.posts) await j('DELETE', `/api/posts/${p.id}`);
  for (const a of s.assets.filter((x) => /^smoke\/|^card$/.test(x.src))) await j('DELETE', `/api/assets/${a.id}`); }

console.log('연기 시험 통과');
