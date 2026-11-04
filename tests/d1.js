// 시험용 D1 껍데기(node:sqlite) — prepare().bind().first/all/run · batch
// 실제 D1 처럼 한 쿼리의 바인딩 변수는 100개까지(넘으면 D1 은 오류)
import { DatabaseSync } from 'node:sqlite';
export function d1() {
  const s = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => { if (a.length > 100) throw new Error('D1_ERROR: too many SQL variables'); return stmt(sql, a); },
    first: async () => s.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: s.prepare(sql).all(...args) }),
    run: async () => { const r = s.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { raw: s, prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const x of list) out.push(await x.run()); return out; } };
}
