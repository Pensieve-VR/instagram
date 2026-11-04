import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetReady } from '../lib/db.js';
import { d1 } from './d1.js';

// 옛 홍보실 표 — 서비스 둘에 같은 Instagram 계정이 연결돼 있던 경우까지
function oldSchema(D) {
  D.raw.exec(`CREATE TABLE services (id TEXT PRIMARY KEY, space TEXT, name TEXT, created INTEGER, updated INTEGER);
CREATE TABLE channels (id TEXT PRIMARY KEY, service_id TEXT, kind TEXT, platform_id TEXT, username TEXT, token_enc TEXT, token_exp INTEGER, meta TEXT, status TEXT, created INTEGER, updated INTEGER);
CREATE TABLE posts (id TEXT PRIMARY KEY, service_id TEXT); CREATE TABLE gates (service_id TEXT); CREATE TABLE materials (id TEXT); CREATE TABLE events (id INTEGER); CREATE TABLE daily (service_id TEXT);`);
  const ins = D.raw.prepare('INSERT INTO channels VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('c1', 's1', 'ig', '1789', 'descartes_works', 'SEALED_IG', 0, JSON.stringify({ name: '데카르트', picture: 'https://p/1.jpg' }), 'linked', 1, 2);
  ins.run('c2', 's1', 'th', '2555', 'descartes_works', 'SEALED_TH', 1893456000000, '{}', 'linked', 1, 3);
  ins.run('c3', 's2', 'ig', '1789', 'descartes_works', 'SEALED_IG_OLD', 0, '{}', 'linked', 1, 1); // 같은 계정 — 하나로
  ins.run('c4', 's2', 'th', '', '', '', 0, '{}', 'linked', 1, 1); // 토큰 없음 — 옮기지 않음
}

test('옛 홍보실 → 르네 콘솔: 연결 토큰만 옮기고 옛 표는 지운다', async () => {
  resetReady();
  const D = d1(); oldSchema(D);
  await db({ DB: D });
  const accts = D.raw.prepare('SELECT * FROM r_accounts ORDER BY sort, platform, lang').all();
  const linked = accts.filter((a) => a.status === 'linked');
  assert.equal(linked.length, 2);
  const ig = linked.find((a) => a.platform === 'ig');
  assert.equal(ig.token_enc, 'SEALED_IG'); // 가장 최근 것, 봉인 그대로
  assert.equal(ig.username, 'descartes_works'); assert.equal(ig.name, '데카르트'); assert.equal(ig.lang, 'ko');
  const th = linked.find((a) => a.platform === 'th');
  assert.equal(th.token_enc, 'SEALED_TH'); assert.equal(th.token_exp, 1893456000000);
  // 없는 줄은 점선으로: IG EN · TH EN · X — 이미 있는 IG KO·TH KO 는 다시 만들지 않는다
  assert.deepEqual(accts.filter((a) => a.status === 'planned').map((a) => `${a.platform}-${a.lang}`).sort(), ['ig-en', 'th-en', 'x-en']);
  const tables = D.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['services', 'channels', 'posts', 'gates', 'materials', 'events', 'daily']) assert.ok(!tables.includes(t), t);
  assert.equal(D.raw.prepare("SELECT v FROM r_meta WHERE k='kv_old'").get().v, '1');
});

test('두 번 돌아도 그대로 · 지운 점선 줄은 되살아나지 않는다', async () => {
  resetReady();
  const D = d1(); oldSchema(D);
  await db({ DB: D });
  D.raw.exec("DELETE FROM r_accounts WHERE platform='x'");
  resetReady(); await db({ DB: D });
  assert.equal(D.raw.prepare('SELECT COUNT(*) AS n FROM r_accounts').get().n, 4);
});

test('옛 표가 없으면(새 설치) 점선 다섯 줄만', async () => {
  resetReady();
  const D = d1();
  await db({ DB: D });
  assert.deepEqual(D.raw.prepare('SELECT platform, lang, status FROM r_accounts ORDER BY sort').all().map((a) => `${a.platform}-${a.lang}-${a.status}`), ['ig-ko-planned', 'th-ko-planned', 'ig-en-planned', 'th-en-planned', 'x-en-planned']);
});

test('동시에 온 첫 요청 · 다른 isolate 의 seed 가 겹쳐도 줄은 다섯', async () => {
  resetReady();
  const D = d1();
  await Promise.all([db({ DB: D }), db({ DB: D }), db({ DB: D })]);
  const { seed } = await import('../lib/db.js');
  await Promise.all([seed(D), seed(D)]);
  assert.equal(D.raw.prepare('SELECT COUNT(*) AS n FROM r_accounts').get().n, 5);
});
