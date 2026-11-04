import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { resetReady } from '../lib/db.js';
import { cleanBeta, joinBeta, betaStats, betaSummary, betaCsv, removeBeta } from '../lib/beta.js';

const fresh = async () => { resetReady(); const env = { DB: d1(), SESSION_SECRET: 'a-long-fixed-secret-value-1234' }; await betaStats(env); return env; };
const ok = (over = {}) => ({ email: 'a@b.co', name: '장영웅', team: '펜시브', stage: 'prefound', needs: ['market', 'plan'], src: 'usf_qr', privacy: true, ...over });

test('cleanBeta — 이메일·개인정보 동의 필수, 소식 수신은 고르기', () => {
  const d = cleanBeta(ok()).data;
  assert.equal(d.email, 'a@b.co');
  assert.equal(d.ad, 0);
  assert.equal(cleanBeta(ok({ ad: true })).data.ad, 1);
  assert.equal(cleanBeta(ok({ email: 'nope' })).error, 'bad_email');
  assert.equal(cleanBeta(ok({ privacy: false })).error, 'consent_required');
  assert.equal(cleanBeta(ok({ hp: 'x' })).error, 'bot');
});

test('cleanBeta — 정해진 값만 남기고 길이를 자른다', () => {
  const d = cleanBeta(ok({ stage: 'ceo', needs: ['market', 'hack', 'market', 'grant'], src: 'USF_QR<x>', name: 'a'.repeat(99), team: ' 팀 ' })).data;
  assert.equal(d.stage, '');
  assert.equal(d.needs, 'market,grant');
  assert.equal(d.src, 'usf_qrx');
  assert.equal(d.name.length, 40);
  assert.equal(d.team, '팀');
});

test('joinBeta — 순번, 같은 이메일은 처음 순번 그대로', async () => {
  const env = await fresh();
  const a = await joinBeta(env, cleanBeta(ok({ email: 'one@x.co' })).data, { ip: '1' });
  const b = await joinBeta(env, cleanBeta(ok({ email: 'two@x.co' })).data, { ip: '2' });
  assert.deepEqual([a.position, b.position], [1, 2]);
  const again = await joinBeta(env, cleanBeta(ok({ email: 'ONE@x.co' })).data, { ip: '3' });
  assert.equal(again.already, true);
  assert.equal(again.position, 1);
  assert.equal((await betaStats(env)).count, 2);
});

test('joinBeta — 같은 곳에서 10분에 5건까지', async () => {
  const env = await fresh();
  for (let i = 0; i < 5; i++) await joinBeta(env, cleanBeta(ok({ email: `p${i}@x.co` })).data, { ip: 'same', now: 1e12 });
  await assert.rejects(joinBeta(env, cleanBeta(ok({ email: 'p9@x.co' })).data, { ip: 'same', now: 1e12 + 1000 }), (e) => e.status === 429);
});

test('요약·CSV·지우기 — 출처와 단계별로 센다', async () => {
  const env = await fresh();
  await joinBeta(env, cleanBeta(ok({ email: 'q1@x.co', src: 'usf_qr' })).data, { ip: 'a' });
  await joinBeta(env, cleanBeta(ok({ email: 'q2@x.co', src: 'usf_card', stage: 'early' })).data, { ip: 'b' });
  const s = await betaSummary(env);
  assert.equal(s.count, 2);
  assert.deepEqual(s.bySrc.map((x) => x.key).sort(), ['usf_card', 'usf_qr']);
  assert.ok(s.byNeed.find((x) => x.key === 'market').n === 2);
  const csv = await betaCsv(env);
  assert.match(csv.split('\n')[0], /^순번,이메일,이름,팀,단계,오래 걸리는 일,출처,소식수신,신청시각/);
  assert.match(csv, /q2@x\.co,장영웅,펜시브,초기 창업,시장조사 · 사업계획서,usf_card,N,/);
  assert.equal(await removeBeta(env, 'Q1@x.co'), 1);
  assert.equal((await betaStats(env)).count, 1);
});
