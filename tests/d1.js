// 시험용 D1 껍데기(node:sqlite) — prepare().bind().first/all/run · batch
import { DatabaseSync } from 'node:sqlite';
export function d1() {
  const s = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => s.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: s.prepare(sql).all(...args) }),
    run: async () => { const r = s.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { raw: s, prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const x of list) out.push(await x.run()); return out; } };
}
