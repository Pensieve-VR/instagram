// 저장 — Cloudflare D1(바인딩 DB). 르네 콘솔 표는 r_ 로 시작한다. 첫 요청 때 저절로 만든다.
// 옛 홍보실 표(services·channels·…)가 있으면: 연결된 계정 토큰만 r_accounts 로 옮기고 옛 표는 지운다(한 번).
let ready = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS r_accounts (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'ko',
  platform_id TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '', token_exp INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'planned',
  slot TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS r_accounts_pid ON r_accounts(platform, platform_id) WHERE platform_id <> '';
CREATE TABLE IF NOT EXISTS r_ideas (
  id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', src TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS r_posts (
  id TEXT PRIMARY KEY, idea_id TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL, format TEXT NOT NULL, state TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', hashtags TEXT NOT NULL DEFAULT '',
  first_reply TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '[]', cover TEXT NOT NULL DEFAULT '', alt TEXT NOT NULL DEFAULT '', trial INTEGER NOT NULL DEFAULT 0,
  progress TEXT NOT NULL DEFAULT '{}', platform_post_id TEXT NOT NULL DEFAULT '', permalink TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', warn TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, metrics TEXT NOT NULL DEFAULT '{}',
  src TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL, published_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS r_posts_due ON r_posts(state, scheduled_at);
CREATE INDEX IF NOT EXISTS r_posts_time ON r_posts(scheduled_at);
CREATE INDEX IF NOT EXISTS r_posts_idea ON r_posts(idea_id);
CREATE TABLE IF NOT EXISTS r_assets (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0, h INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', src TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS r_assets_src ON r_assets(src);
CREATE TABLE IF NOT EXISTS r_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS r_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS r_waitlist (
  n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, src TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'ko',
  color TEXT NOT NULL DEFAULT '', bundle TEXT NOT NULL DEFAULT '', earlybird INTEGER NOT NULL DEFAULT 0, ad INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS r_waitlist_ip ON r_waitlist(ip, created);
CREATE TABLE IF NOT EXISTS d_beta (
  n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', team TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '', needs TEXT NOT NULL DEFAULT '', src TEXT NOT NULL DEFAULT '', ad INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS d_beta_ip ON d_beta(ip, created);
CREATE TABLE IF NOT EXISTS r_dm (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
  media_id TEXT NOT NULL DEFAULT '', post_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS r_dm_user ON r_dm(account_id, user_id, state);
CREATE INDEX IF NOT EXISTS r_dm_at ON r_dm(at)`;

const OLD = ['services', 'channels', 'gates', 'materials', 'posts', 'events', 'daily'];

let initP = null; // 같은 isolate 안에서 동시에 온 첫 요청들이 표 만들기·옮기기를 두 번 하지 않게
export async function db(env) {
  if (!env.DB) throw Object.assign(new Error('no_store'), { status: 503 });
  if (!ready) {
    initP ||= (async () => {
      const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
      await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
      await migrate(env.DB);
      await seed(env.DB);
      ready = true;
    })().catch((e) => { initP = null; throw e; });
    await initP;
  }
  return env.DB;
}
export const resetReady = () => { ready = false; initP = null; };

// 옛 홍보실 → 르네 콘솔. 연결 토큰(봉인된 그대로)만 옮긴다. 같은 계정이 여러 서비스에 있었으면 하나로.
export async function migrate(DB) {
  const old = await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'").first();
  if (!old) return 0;
  const { results } = await DB.prepare("SELECT * FROM channels WHERE token_enc <> '' AND platform_id <> '' ORDER BY updated DESC").all();
  const t = Date.now(); let n = 0;
  for (const r of results) {
    if (!['ig', 'th'].includes(r.kind)) continue;
    const m = J(r.meta, {});
    const res = await DB.prepare(`INSERT OR IGNORE INTO r_accounts (id,platform,lang,platform_id,username,name,picture,token_enc,token_exp,status,sort,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId('a'), r.kind, 'ko', String(r.platform_id), r.username || '', m.name || '', m.picture || '', r.token_enc, Number(r.token_exp) || 0,
        r.status === 'linked' ? 'linked' : 'expired', r.kind === 'ig' ? 0 : 1, t, t).run();
    if (res.meta && res.meta.changes) n++;
  }
  await DB.batch(OLD.map((name) => DB.prepare(`DROP TABLE IF EXISTS ${name}`)));
  await DB.batch([
    DB.prepare("INSERT OR REPLACE INTO r_meta (k, v) VALUES ('kv_old', '1')"), // 옛 미디어(m/·c/)는 크론이 지운다
    DB.prepare('INSERT INTO r_events (kind, level, detail, at) VALUES (?,?,?,?)').bind('migrated', 'info', `옛 홍보실 → 르네 콘솔 · 연결 ${n}개 옮김`, t),
  ]);
  return n;
}

// 처음 한 번 — 아직 없는 줄을 점선(planned)으로 세운다. 지운 줄이 되살아나지 않게 한 번만.
const PLAN_LINES = [['ig', 'ko', 0], ['th', 'ko', 1], ['ig', 'en', 2], ['th', 'en', 3], ['x', 'en', 4]];
// 한 batch(=한 트랜잭션) 안에서 「없을 때만」 넣는다 — 다른 isolate 가 동시에 돌아도 겹치지 않는다
export async function seed(DB) {
  const t = Date.now();
  const stmts = PLAN_LINES.map(([p, l, s]) => DB.prepare(`INSERT INTO r_accounts (id,platform,lang,status,sort,created,updated)
    SELECT ?,?,?,'planned',?,?,? WHERE NOT EXISTS (SELECT 1 FROM r_meta WHERE k='seeded') AND NOT EXISTS (SELECT 1 FROM r_accounts WHERE platform=? AND lang=?)`)
    .bind(newId('a'), p, l, s, t, t, p, l));
  stmts.push(DB.prepare("INSERT OR IGNORE INTO r_meta (k, v) VALUES ('seeded', '1')"));
  await DB.batch(stmts);
}

export const isId = (v, prefix) => new RegExp(`^${prefix}[a-z0-9]{6,24}$`).test(String(v || ''));
export const J = (s, fallback) => { try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; } };
export const newId = (prefix) => prefix + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');

export async function event(env, kind, detail = '', level = 'info') {
  const d = await db(env);
  await d.prepare('INSERT INTO r_events (kind, level, detail, at) VALUES (?,?,?,?)').bind(kind, level, String(detail).slice(0, 600), Date.now()).run();
}
export async function metaGet(env, k) { const d = await db(env); const r = await d.prepare('SELECT v FROM r_meta WHERE k=?').bind(k).first(); return r ? r.v : null; }
export async function metaSet(env, k, v) { const d = await db(env); await d.prepare('INSERT OR REPLACE INTO r_meta (k, v) VALUES (?, ?)').bind(k, String(v)).run(); }

export function rowAccount(r) {
  if (!r) return null;
  const { token_enc, ...rest } = r; // 토큰은 밖으로 내보내지 않는다
  return { ...rest, hasToken: !!token_enc };
}
export function rowPost(r) {
  if (!r) return null;
  return { ...r, media: J(r.media, []), progress: J(r.progress, {}), metrics: J(r.metrics, {}) };
}
