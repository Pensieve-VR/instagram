import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { resetReady } from '../lib/db.js';
import { cleanSignup, join, stats, summary, toCsv, setCap, allowedOrigin } from '../lib/waitlist.js';

const fresh = async () => { resetReady(); const env = { DB: d1(), SESSION_SECRET: 'a-long-fixed-secret-value-1234' }; await stats(env); return env; };
const ok = (over = {}) => ({ email: 'a@b.co', src: 'ig_p1', lang: 'ko', color: 'doze', bundle: 'solo', privacy: true, ad: true, ...over });

test('cleanSignup — 이메일·동의 필수, 나머지는 정해진 값만', () => {
  assert.equal(cleanSignup(ok()).data.email, 'a@b.co');
  assert.equal(cleanSignup(ok({ email: '  A@B.CO ' })).data.email, 'a@b.co');
  assert.equal(cleanSignup(ok({ email: 'nope' })).error, 'bad_email');
  assert.equal(cleanSignup(ok({ privacy: false })).error, 'consent_required');
  assert.equal(cleanSignup(ok({ ad: false })).error, 'consent_required');
  assert.equal(cleanSignup(ok({ hp: 'bot' })).error, 'bot');
  const d = cleanSignup(ok({ src: 'IG_P1<script>', color: 'pink', bundle: 'x', lang: 'jp' })).data;
  assert.equal(d.src, 'ig_p1script'); assert.equal(d.color, ''); assert.equal(d.bundle, ''); assert.equal(d.lang, 'ko');
});

test('join — 순번, 같은 이메일은 그 순번 그대로', async () => {
  const env = await fresh();
  const a = await join(env, cleanSignup(ok({ email: 'one@x.co' })).data, { ip: '1.1.1.1' });
  const b = await join(env, cleanSignup(ok({ email: 'two@x.co' })).data, { ip: '2.2.2.2' });
  assert.deepEqual([a.position, b.position], [1, 2]);
  assert.equal(a.earlybird, true); assert.equal(a.already, false);
  const again = await join(env, cleanSignup(ok({ email: 'ONE@x.co' })).data, { ip: '3.3.3.3' });
  assert.equal(again.already, true); assert.equal(again.position, 1);
  assert.match(a.ref, /^w[a-z0-9]{6,}$/);
});

test('선착순 N 을 넘으면 얼리버드 아님(알림만)', async () => {
  const env = await fresh();
  await setCap(env, 1);
  const a = await join(env, cleanSignup(ok({ email: 'a1@x.co' })).data, { ip: 'i1' });
  const b = await join(env, cleanSignup(ok({ email: 'a2@x.co' })).data, { ip: 'i2' });
  assert.equal(a.earlybird, true); assert.equal(b.earlybird, false);
  const s = await stats(env);
  assert.deepEqual([s.count, s.cap, s.left], [2, 1, 0]);
});

test('같은 곳에서 10분에 5번 넘게 새로 신청하면 막는다', async () => {
  const env = await fresh();
  for (let i = 0; i < 5; i++) await join(env, cleanSignup(ok({ email: `r${i}@x.co` })).data, { ip: 'same' });
  await assert.rejects(join(env, cleanSignup(ok({ email: 'r9@x.co' })).data, { ip: 'same' }), (e) => e.status === 429);
  const other = await join(env, cleanSignup(ok({ email: 'r9@x.co' })).data, { ip: 'other' });
  assert.equal(other.position, 6);
});

test('summary · CSV — 출처·컬러별, IP 는 원문을 남기지 않는다', async () => {
  const env = await fresh();
  await join(env, cleanSignup(ok({ email: 'c1@x.co', src: 'th_t1', color: 'cloud' })).data, { ip: '9.9.9.9' });
  await join(env, cleanSignup(ok({ email: 'c2@x.co', src: 'th_t1', color: 'doze' })).data, { ip: '8.8.8.8' });
  await join(env, cleanSignup(ok({ email: 'c3@x.co', src: '', color: '' })).data, { ip: '7.7.7.7' });
  const s = await summary(env);
  assert.deepEqual(s.bySrc[0], { key: 'th_t1', n: 2 });
  assert.ok(s.bySrc.some((x) => x.key === '(바로)' && x.n === 1));
  assert.ok(s.byColor.some((x) => x.key === 'cloud'));
  const raw = env.DB.raw.prepare('SELECT ip FROM r_waitlist').all().map((r) => r.ip);
  assert.ok(raw.every((ip) => !/\d+\.\d+/.test(ip)));
  const csv = await toCsv(env);
  assert.match(csv.split('\n')[0], /^순번,이메일,출처/);
  assert.equal(csv.trim().split('\n').length, 4);
  assert.match(csv, /c1@x\.co/);
});

test('allowedOrigin — pensieve.kr 홈페이지만(그리고 같은 출처)', () => {
  const req = (o, u = 'https://instagram.pensieve.kr/api/waitlist') => new Request(u, { headers: o ? { origin: o } : {} });
  assert.equal(allowedOrigin(req('https://www.pensieve.kr'), {}), 'https://www.pensieve.kr');
  assert.equal(allowedOrigin(req('https://pensieve.kr'), {}), 'https://pensieve.kr');
  assert.equal(allowedOrigin(req('https://evil.example'), {}), '');
  assert.equal(allowedOrigin(req('https://instagram.pensieve.kr'), {}), 'https://instagram.pensieve.kr');
  assert.equal(allowedOrigin(req('http://localhost:5173'), { WAITLIST_ORIGINS: 'http://localhost:5173' }), 'http://localhost:5173');
  assert.equal(allowedOrigin(req(''), {}), '');
});

test('remove — 이메일로 지우면 뒤 순번이 당겨진다', async () => {
  const { remove } = await import('../lib/waitlist.js');
  const env = await fresh();
  await join(env, cleanSignup(ok({ email: 'x1@x.co' })).data, { ip: 'a' });
  await join(env, cleanSignup(ok({ email: 'x2@x.co' })).data, { ip: 'b' });
  assert.equal(await remove(env, ' X1@x.co '), 1);
  const again = await join(env, cleanSignup(ok({ email: 'x2@x.co' })).data, { ip: 'c' });
  assert.equal(again.position, 1);
});
