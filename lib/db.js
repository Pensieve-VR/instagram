// 저장 — Cloudflare D1(바인딩 DB). 표는 첫 요청 때 저절로 만든다.
// 공간(space)마다 서비스 묶음이 따로다. 서비스 하나 = Instagram·Threads 노선 둘.
let ready = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, space TEXT NOT NULL, name TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '', oneliner TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
  candidates TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}', brief TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS services_space ON services(space, created);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, kind TEXT NOT NULL,
  platform_id TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '', token_exp INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'linked',
  created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE(service_id, kind)
);
CREATE TABLE IF NOT EXISTS gates (
  service_id TEXT NOT NULL, kind TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(service_id, kind)
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_service ON materials(service_id, created);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, channel TEXT NOT NULL, angle TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, scheduled_at INTEGER NOT NULL DEFAULT 0, hook TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '', hashtags TEXT NOT NULL DEFAULT '', card TEXT NOT NULL DEFAULT '', alt TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]', material_id TEXT NOT NULL DEFAULT '',
  container_id TEXT NOT NULL DEFAULT '', platform_post_id TEXT NOT NULL DEFAULT '', permalink TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', metrics TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, published_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_due ON posts(state, scheduled_at);
CREATE INDEX IF NOT EXISTS posts_service ON posts(service_id, scheduled_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
  detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_service ON events(service_id, at);
CREATE TABLE IF NOT EXISTS daily (
  service_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(service_id, day)
);`;

export async function db(env) {
  if (!env.DB) throw new Error('no_store');
  if (!ready) {
    const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
    // 옛 표 보정 — 이미 있는 열이면 D1 이 거절하므로 그 오류만 삼킨다
    for (const sql of ["ALTER TABLE posts ADD COLUMN alt TEXT NOT NULL DEFAULT ''"]) {
      try { await env.DB.prepare(sql).run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
    ready = true;
  }
  return env.DB;
}
export const resetReady = () => { ready = false; };

export const isId = (v, prefix) => new RegExp(`^${prefix}[a-z0-9]{6,24}$`).test(String(v || ''));
export const J = (s, fallback) => { try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; } };

export async function event(env, serviceId, kind, detail = '', level = 'info') {
  const d = await db(env);
  await d.prepare('INSERT INTO events (service_id, kind, level, detail, at) VALUES (?,?,?,?,?)')
    .bind(serviceId, kind, level, String(detail).slice(0, 600), Date.now()).run();
}

export function rowService(r) {
  if (!r) return null;
  return { ...r, candidates: J(r.candidates, []), settings: J(r.settings, {}) };
}
export function rowPost(r) {
  if (!r) return null;
  return { ...r, card: J(r.card, null), media: J(r.media, []), metrics: J(r.metrics, {}) };
}
export function rowChannel(r) {
  if (!r) return null;
  const { token_enc, ...rest } = r; // 토큰은 밖으로 내보내지 않는다
  return { ...rest, meta: J(r.meta, {}), hasToken: !!token_enc };
}
