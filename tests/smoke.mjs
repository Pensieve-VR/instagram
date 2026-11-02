// 연기 시험 — 로컬 wrangler dev(MOCK_AI=1, PASSWORDS=나=test) 를 상대로 흐름 전체를 한 번 돈다.
//   npm run dev  (다른 터미널)  →  node tests/smoke.mjs [http://127.0.0.1:8787]
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

step('health');
{ const { status, data } = await j('GET', '/api/health'); assert.equal(status, 200); assert.equal(data.mock, true); assert.equal(data.passwords, true); }

step('잠긴 상태에서는 state 거절');
{ const { status } = await j('GET', '/api/state'); assert.equal(status, 401); }

step('틀린 암호 · 맞는 암호 · 남의 origin');
{ const w = await j('POST', '/api/login', { password: 'nope' }); assert.equal(w.status, 401);
  const bad = await fetch(BASE + '/api/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test' }) }); assert.equal(bad.status, 403);
  const ok = await j('POST', '/api/login', { password: 'test' }); assert.equal(ok.status, 200); token = ok.data.token; assert.equal(ok.data.name, '나'); }

step('지난 시험 찌꺼기 치우기 → 빈 공간 state');
{ const first = await j('GET', '/api/state'); for (const s of first.data.services) await j('DELETE', `/api/services/${s.id}`);
  const { status, data } = await j('GET', '/api/state'); assert.equal(status, 200); assert.equal(data.service, null); assert.deepEqual(data.services, []); }

step('서비스 만들기 → 후보');
let sid;
{ const r = await j('POST', '/api/services', { name: '될까?', brief: '아이디어 검증 도구' }); assert.equal(r.status, 201); sid = r.data.service.id; assert.match(sid, /^s[a-z0-9]+$/); assert.equal(r.data.service.candidates.length, 5); assert.ok(r.data.service.oneliner);
  const empty = await j('POST', '/api/services', { name: '  ' }); assert.equal(empty.status, 400); }

step('이름 고르기 — 나쁜 이름 거절');
{ assert.equal((await j('POST', `/api/services/${sid}/handle`, { handle: '..bad' })).status, 400);
  const r = await j('POST', `/api/services/${sid}/handle`, { handle: '@Delka.KR' }); assert.equal(r.status, 200); assert.equal(r.data.handle, 'delka.kr'); }

step('게이트 ① 통과 · 잘못된 게이트 거절');
{ assert.equal((await j('POST', `/api/services/${sid}/gates/nope`, { done: true })).status, 400);
  const r = await j('POST', `/api/services/${sid}/gates/signup`, { done: true }); assert.equal(r.status, 200); assert.equal(r.data.gates.signup, 1); }

step('프로필 생성 · 이미지');
{ const r = await j('POST', `/api/services/${sid}/profile`); assert.equal(r.status, 200); assert.ok(r.data.profile.bio);
  const img = await fetch(BASE + `/api/services/${sid}/profile-image.svg`, { headers: h() }); assert.equal(img.status, 200); assert.match(img.headers.get('content-type'), /svg/);
  const noauth = await fetch(BASE + `/api/services/${sid}/profile-image.svg`); assert.equal(noauth.status, 401); }

step('소재 — 글 · 잘못된 종류 · 파일(md)');
{ assert.equal((await j('POST', `/api/services/${sid}/materials`, { type: 'text', text: '될까?는 아이디어를 14갈래로 조사한다. 2026년 10월 출시.' })).status, 201);
  assert.equal((await j('POST', `/api/services/${sid}/materials`, { type: 'weird' })).status, 400);
  assert.equal((await j('POST', `/api/services/${sid}/materials`, { type: 'text', text: '   ' })).status, 400);
  const fd = new FormData(); fd.append('file', new Blob(['# 설명서\n핵심 기능 셋'], { type: 'text/markdown' }), '설명서.md');
  assert.equal((await j('POST', `/api/services/${sid}/materials`, fd)).status, 201);
  const fd2 = new FormData(); fd2.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'x.pdf');
  assert.equal((await j('POST', `/api/services/${sid}/materials`, fd2)).status, 415); }

step('설정 — 손상 입력은 기본으로');
{ const r = await j('POST', `/api/services/${sid}/settings`, { approval: 'auto', ig: { slots: [{ dow: 2, hm: '20:00' }, { dow: 99, hm: 'x' }] }, th: { slots: [{ dow: 1, hm: '12:30' }] } });
  assert.equal(r.status, 200); assert.equal(r.data.settings.approval, 'auto'); assert.deepEqual(r.data.settings.ig.slots, [{ dow: 2, hm: '20:00' }]); assert.equal(r.data.settings.profile && r.data.settings.profile.bio.length > 0, true); }

step('이번 주 채우기(mock) → 역 생성');
let posts;
{ const r = await j('POST', `/api/services/${sid}/plan`, { days: 7 }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.made.length >= 1, '역이 하나는 서야 한다');
  const again = await j('POST', `/api/services/${sid}/plan`, { days: 7 }); assert.equal(again.data.made.length, 0, '같은 슬롯에 두 번 세우지 않는다');
  const st = await j('GET', `/api/state?service=${sid}`); posts = st.data.posts; assert.ok(posts.length >= 1); assert.ok(st.data.materials.length === 2);
  assert.ok(st.data.signals.length >= 1); }

step('역 조작 — 승인·수정·보류·건너뜀·잘못된 전이');
{ const th = posts.find((p) => p.channel === 'th') || posts[0];
  const e = await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'edit', text: '고친 글', scheduled_at: th.scheduled_at + 60000 }); assert.equal(e.status, 200); assert.equal(e.data.post.text, '고친 글'); assert.equal(e.data.post.scheduled_at, th.scheduled_at + 60000);
  if (e.data.post.state === 'scheduled') { const hold = await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'hold' }); assert.equal(hold.data.post.state, 'review'); }
  const ap = await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'approve' }); assert.equal(ap.data.post.state, 'scheduled');
  const badT = await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'approve' }); assert.equal(badT.status, 409);
  assert.equal((await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'explode' })).status, 400);
  assert.equal((await j('POST', `/api/services/${sid}/posts/p000000notreal`, { action: 'skip' })).status, 404);
  const other = posts.find((p) => p.id !== th.id); if (other) { const sk = await j('POST', `/api/services/${sid}/posts/${other.id}`, { action: 'skip' }); assert.equal(sk.data.post.state, 'skipped'); } }

step('크론 — 연결 없는 노선의 예약 글은 fail-loud(실패 + 기록)');
{ const th = posts.find((p) => p.channel === 'th') || posts[0];
  await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'edit', scheduled_at: Date.now() - 60000 });
  const cron = await fetch(BASE + '/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*'); assert.ok(cron.ok, 'local scheduled trigger');
  await new Promise((r) => setTimeout(r, 800));
  const st = await j('GET', `/api/state?service=${sid}`);
  const after = st.data.posts.find((p) => p.id === th.id);
  assert.equal(after.state, 'failed', JSON.stringify(after)); assert.match(after.error, /연결 없음/);
  assert.ok(st.data.events.some((e) => e.kind === 'post.failed'));
  const retry = await j('POST', `/api/services/${sid}/posts/${th.id}`, { action: 'retry' }); assert.equal(retry.data.post.state, 'scheduled'); }

step('소재 삭제 — 그 이미지를 쓰던 글은 승인 대기로 (응답에 detached)');
{ const st = await j('GET', `/api/state?service=${sid}`); const txt = st.data.materials.find((x) => x.type === 'text');
  const r = await j('DELETE', `/api/services/${sid}/materials/${txt.id}`); assert.equal(r.status, 200); assert.equal(r.data.detached, 0);
  assert.equal((await j('DELETE', `/api/services/${sid}/materials/m000000notreal`)).status, 404); }

step('주 이동 — week 파라미터로 다른 주의 글을 받는다');
{ const now = Date.now(); const far = await j('GET', `/api/state?service=${sid}&week=${now + 40 * 86400000}`); assert.equal(far.status, 200); assert.equal(far.data.posts.length, 0);
  const here = await j('GET', `/api/state?service=${sid}&week=${now}`); assert.ok(here.data.posts.length >= 1); }

step('지금 게시 — 연결 없음은 실패로 답한다');
{ const th = posts.find((p) => p.channel === 'th') || posts[0];
  const r = await j('POST', `/api/services/${sid}/posts/${th.id}/now`, {}); assert.equal(r.status, 200); assert.equal(r.data.result, 'failed'); }

step('미디어 경로 — 없는 키는 404, 이상한 키는 404');
{ assert.equal((await fetch(BASE + '/media/c/sabc/nothing.jpg')).status, 404); assert.equal((await fetch(BASE + '/media/c/sabc/..%2F..%2Fx.jpg')).status, 404); assert.equal((await fetch(BASE + '/media/zz/not-a-service/x.jpg')).status, 404); }

step('OAuth 시작 — 앱 키 없으면 503, 되돌아오기 잘못된 state 는 리다이렉트');
{ const r = await j('GET', `/api/oauth/ig/start?service=${sid}`); assert.equal(r.status, 503);
  const cb = await fetch(BASE + '/api/oauth/ig/callback?state=junk&code=x', { redirect: 'manual' }); assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /oauth=bad_state/); }

step('없는 서비스 주소 → 마지막 서비스로 대체');
{ const r = await j('GET', '/api/state?service=s000000notreal'); assert.equal(r.status, 200); assert.equal(r.data.service.id, sid); }

step('요약 · 기록');
{ const r = await j('POST', `/api/services/${sid}/sync`, {}); assert.equal(r.status, 200); assert.ok(r.data.daily && r.data.daily.day);
  const ev = await j('GET', `/api/services/${sid}/events`); assert.ok(ev.data.events.length > 3); }

step('지우기');
{ const r = await j('DELETE', `/api/services/${sid}`); assert.equal(r.status, 200); const st = await j('GET', `/api/state?service=${sid}`); assert.equal(st.data.service, null); assert.deepEqual(st.data.services, []); }

console.log('연기 시험 통과');
