import test from 'node:test';
import assert from 'node:assert/strict';
import { entries, login, verifyToken, makeState, readState, configured } from '../lib/auth.js';
import { seal, open } from '../lib/crypto.js';
import { extractJson, mock } from '../lib/ai.js';
import { MetaError, authUrl, stripCode } from '../lib/meta.js';
import * as meta from '../lib/meta.js';

const env = { PASSWORDS: '영웅=secret1, 다호=secret2,\nplainpw' };

test('PASSWORDS 해석', () => {
  assert.deepEqual(entries(env), [{ name: '영웅', pw: 'secret1' }, { name: '다호', pw: 'secret2' }, { name: '', pw: 'plainpw' }]);
  assert.equal(configured({}), false);
  assert.deepEqual(entries({ PASSWORDS: ' , ,' }), []);
});

test('로그인 → 열쇠 → 검증, 같은 이름은 같은 공간', async () => {
  const a = await login(env, 'secret1'); const b = await login({ PASSWORDS: '영웅=changed' }, 'changed');
  assert.ok(a && a.token); assert.equal(a.name, '영웅'); assert.equal(a.space, b.space);
  const who = await verifyToken(env, a.token);
  assert.deepEqual(who, { space: a.space, name: '영웅' });
  assert.equal(await login(env, 'nope'), null);
  assert.equal(await login(env, ''), null);
  assert.equal(await verifyToken(env, a.token + 'x'), null);
  assert.equal(await verifyToken(env, 'a.b.c'), null);
  assert.equal(await verifyToken({ PASSWORDS: 'other' }, a.token), null); // 다른 비밀로는 검증 실패
  const p = await login(env, 'plainpw'); assert.equal(p.name, '홍보실'); assert.match(p.space, /^p-/);
});

test('OAuth state 왕복', async () => {
  const st = await makeState(env, 'u-0123456789abcdef', 's0abc123', 'ig');
  assert.deepEqual(await readState(env, st), { space: 'u-0123456789abcdef', serviceId: 's0abc123', kind: 'ig' });
  assert.equal(await readState(env, st.replace(/ig/, 'th')), null); // 변조
  assert.equal(await readState(env, 'junk'), null);
  assert.equal(await readState({ PASSWORDS: 'x' }, st), null);
});

test('토큰 봉인 왕복 · 다른 열쇠로는 못 연다 · 비밀 없으면 거절(암호를 바꿔도 토큰이 살아야 한다)', async () => {
  const senv = { ...env, SESSION_SECRET: 'a-long-fixed-secret-value-1234' };
  const sealed = await seal(senv, 'IGQVJ…token한글');
  assert.notEqual(sealed, 'IGQVJ…token한글');
  assert.equal(await open(senv, sealed), 'IGQVJ…token한글');
  assert.equal(await open({ ...senv, PASSWORDS: 'changed=pw' }, sealed), 'IGQVJ…token한글'); // 암호가 바뀌어도 열린다
  await assert.rejects(open({ ...senv, SESSION_SECRET: 'another-long-secret-value-5678' }, sealed));
  await assert.rejects(open(senv, 'AAAA'), /sealed_too_short/);
  assert.equal(await open(senv, ''), '');
  await assert.rejects(seal(env, 'x'), /no_secret/);
  await assert.rejects(seal({ ...env, SESSION_SECRET: 'short' }, 'x'), /no_secret/);
});

test('extractJson — 울타리·앞뒤 말·중첩·문자열 속 괄호', () => {
  assert.deepEqual(extractJson('여기요\n```json\n{"a":1,"b":[1,2,{"c":"}"}]}\n```'), { a: 1, b: [1, 2, { c: '}' }] });
  assert.deepEqual(extractJson('[1,2,3] 끝'), [1, 2, 3]);
  assert.deepEqual(extractJson('{"s":"escaped \\" quote { [","n":null}'), { s: 'escaped " quote { [', n: null });
  assert.throws(() => extractJson('json 없음'), /ai_no_json/);
  assert.throws(() => extractJson('{"a":1'), /ai_unclosed_json/);
  assert.throws(() => extractJson('{"a":]'), /ai_bad_json/);
  assert.throws(() => extractJson('{a:1}'), /ai_bad_json/);
});

test('mock 답은 모양이 맞다', () => {
  const c = mock('candidates', '서비스 이름: 될까?\n');
  assert.equal(c.candidates.length, 6); assert.ok(c.candidates.every((x) => x.handle && x.why));
  assert.equal(mock('profile', '서비스 이름: 르네\n').options.length, 3);
  assert.ok(mock('post', 'x').card.headline);
  assert.equal(mock('whatever', 'x').ok, true);
});

test('서버는 Instagram 프로필을 직접 긁지 않는다(약관) — handleFree 없음', () => {
  assert.equal('handleFree' in meta, false);
});

test('authUrl · MetaError · stripCode', () => {
  // Instagram — Unified login: Facebook 대화상자 + config_id, scope 는 보내지 않는다
  const igEnv = { IG_APP_ID: '123', IG_APP_SECRET: 'x', IG_CONFIG_ID: '777' };
  const u = new URL(authUrl(igEnv, 'ig', 'https://h/cb', 'st'));
  assert.equal(u.host, 'www.facebook.com'); assert.equal(u.pathname, '/dialog/oauth');
  assert.equal(u.searchParams.get('client_id'), '123'); assert.equal(u.searchParams.get('config_id'), '777'); assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('scope'), null);
  assert.equal(meta.appReady(igEnv, 'ig'), true);
  assert.equal(meta.appReady({ IG_APP_ID: '123', IG_APP_SECRET: 'x' }, 'ig'), false, '구성 ID 없으면 준비 안 됨');
  assert.equal(meta.base({}, 'ig'), 'https://graph.facebook.com/v26.0');
  assert.equal(meta.refreshable('ig'), false); assert.equal(meta.refreshable('th'), true);
  assert.deepEqual(meta.pickAccount([{ id: '1', username: 'a' }, { id: '2', username: 'Descartes_Works' }], 'descartes_works'), { id: '2', username: 'Descartes_Works' });
  assert.deepEqual(meta.pickAccount([{ id: '1', username: 'a' }], 'zzz'), { id: '1', username: 'a' });
  assert.equal(meta.pickAccount([], 'zzz'), null);
  const t = new URL(authUrl({ THREADS_APP_ID: '9', THREADS_APP_SECRET: 'x', THREADS_SCOPES: 'threads_basic' }, 'th', 'https://h/cb', 'st'));
  assert.equal(t.searchParams.get('scope'), 'threads_basic');
  const e = new MetaError('Error validating access token', { code: 190, type: 'OAuthException' });
  assert.equal(e.tokenProblem, true); assert.equal(new MetaError('x', { code: 4 }).rateLimited, true); assert.equal(new MetaError('x', { code: 100 }).tokenProblem, false);
  assert.equal(stripCode('abc#_'), 'abc'); assert.equal(stripCode('abc'), 'abc');
});

test('signed_request — 앱 시크릿 서명이 맞을 때만 읽는다', async () => {
  const secret = 'app-secret';
  const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = b64u(new TextEncoder().encode(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '42' })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))));
  assert.equal((await meta.parseSignedRequest(secret, `${sig}.${body}`)).user_id, '42');
  assert.equal(await meta.parseSignedRequest('other', `${sig}.${body}`), null);
  assert.equal(await meta.parseSignedRequest(secret, 'garbage'), null);
});
