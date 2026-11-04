// 될까? 베타테스터 신청 — 베타 모집 사이트(beta.pensieve.kr)가 부르는 공개 API 와 콘솔용 요약·CSV.
// 르네 대기 명단(r_waitlist)과 섞지 않는다. 표 d_beta 는 lib/db.js SCHEMA 에서 만든다.
// 받는 것: 이메일(필수) · 이름 · 팀 · 단계 · 오래 걸리는 일 · 출처(src) · 동의. IP 는 해시로만(도배 막기용).
import { db, newId } from './db.js';

export const STAGES = { idea: '아이디어', prefound: '예비 창업', early: '초기 창업', growth: '성장 단계', edu: '교육·지원 기관', other: '기타' };
export const NEEDS = { market: '시장조사', competitor: '경쟁사 조사', validate: '아이디어 검증', plan: '사업계획서', grant: '지원사업 찾기', customer: '고객 인터뷰' };
const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i;
const fail = (status, error) => Object.assign(new Error(error), { status });
const text = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

export function cleanBeta(b) {
  const s = b && typeof b === 'object' ? b : {};
  if (s.hp) return { error: 'bot' }; // 사람에겐 안 보이는 칸
  const email = String(s.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return { error: 'bad_email' };
  if (s.privacy !== true) return { error: 'consent_required' };
  const needs = [...new Set((Array.isArray(s.needs) ? s.needs : []).filter((x) => x in NEEDS))];
  return {
    data: {
      email,
      name: text(s.name, 40),
      team: text(s.team, 60),
      stage: s.stage in STAGES ? s.stage : '',
      needs: needs.join(','),
      src: String(s.src || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40),
      ad: s.ad === true ? 1 : 0,
    },
  };
}

async function ipHash(env, ip) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`beta|${env.SESSION_SECRET || ''}|${ip || ''}`));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const positionOf = async (d, n) => (await d.prepare('SELECT COUNT(*) AS c FROM d_beta WHERE n <= ?').bind(n).first()).c;

// 신청 — 있던 이메일이면 그 순번. 같은 곳(IP)에서 10분 5건까지(부스 와이파이 하나로 여러 명이 신청해도 막히지 않을 만큼).
export async function joinBeta(env, data, { ip = '', now = Date.now() } = {}) {
  const d = await db(env);
  const old = await d.prepare('SELECT n FROM d_beta WHERE email=?').bind(data.email).first();
  if (old) return { position: await positionOf(d, old.n), already: true };
  const h = await ipHash(env, ip);
  const recent = await d.prepare('SELECT COUNT(*) AS c FROM d_beta WHERE ip=? AND created>?').bind(h, now - 600e3).first();
  if (recent.c >= 5) throw fail(429, 'too_many');
  const r = await d.prepare('INSERT OR IGNORE INTO d_beta (id,email,name,team,stage,needs,src,ad,ip,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(newId('b').slice(0, 11), data.email, data.name, data.team, data.stage, data.needs, data.src, data.ad, h, now).run();
  if (!(r.meta && r.meta.changes)) return joinBeta(env, data, { ip, now }); // 같은 이메일이 동시에
  const row = await d.prepare('SELECT n FROM d_beta WHERE email=?').bind(data.email).first();
  return { position: await positionOf(d, row.n), already: false };
}

export async function betaStats(env) {
  const d = await db(env);
  return { count: (await d.prepare('SELECT COUNT(*) AS c FROM d_beta').first()).c || 0 };
}

const KST = 9 * 3600e3;
const when = (t) => new Date(t + KST).toISOString().slice(0, 16).replace('T', ' ');
const needNames = (s) => String(s || '').split(',').filter(Boolean).map((k) => NEEDS[k] || k).join(' · ');

export async function betaSummary(env) {
  const d = await db(env);
  const { results: rows } = await d.prepare('SELECT n, email, name, team, stage, needs, src, ad, created FROM d_beta ORDER BY n DESC').all();
  const count = (pick) => {
    const m = {};
    for (const r of rows) for (const k of pick(r)) m[k] = (m[k] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
  };
  return {
    count: rows.length,
    bySrc: count((r) => [r.src || '(바로)']),
    byStage: count((r) => [STAGES[r.stage] || '(고르지 않음)']),
    byNeed: count((r) => String(r.needs || '').split(',').filter(Boolean)),
    recent: rows.slice(0, 50).map((r) => ({ ...r, stage: STAGES[r.stage] || '', needs: needNames(r.needs), created: when(r.created) })),
  };
}

const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export async function betaCsv(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT email, name, team, stage, needs, src, ad, created FROM d_beta ORDER BY n').all();
  const head = '순번,이메일,이름,팀,단계,오래 걸리는 일,출처,소식수신,신청시각(KST)';
  const rows = results.map((r, i) => [i + 1, r.email, r.name, r.team, STAGES[r.stage] || '', needNames(r.needs), r.src, r.ad ? 'Y' : 'N', when(r.created)].map(cell).join(','));
  return [head, ...rows].join('\n') + '\n';
}

// 지우기(시험 신청·본인 요청) — 이메일로
export async function removeBeta(env, email) {
  const d = await db(env);
  const r = await d.prepare('DELETE FROM d_beta WHERE email=?').bind(String(email || '').trim().toLowerCase()).run();
  return (r.meta && r.meta.changes) || 0;
}
