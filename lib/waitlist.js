// 르네 얼리버드 대기 명단 — 홈페이지(pensieve.kr/early)가 부르는 공개 API 와 콘솔 「명단」.
// 결제는 받지 않는다. 이메일·출처(src)·원하는 컬러·구성·동의만. IP 는 해시로만(도배 막기용).
import { db, metaGet, metaSet, newId } from './db.js';

export const DEFAULT_CAP = 300;
const COLORS = ['doze', 'cloud', 'sprout', 'whale'];
const BUNDLES = ['solo', 'set'];
const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i;
const fail = (status, error) => Object.assign(new Error(error), { status });

// 홈페이지에서만 받는다. 같은 출처(콘솔) · 설정 WAITLIST_ORIGINS(쉼표) 도 허용
export function allowedOrigin(request, env) {
  const o = request.headers.get('origin') || '';
  if (!o) return '';
  let u; try { u = new URL(o); } catch { return ''; }
  if (u.protocol === 'https:' && ['pensieve.kr', 'www.pensieve.kr', 'beta.pensieve.kr'].includes(u.hostname)) return u.origin; // beta.pensieve.kr = 될까? 베타 모집 사이트
  try { if (new URL(request.url).origin === u.origin) return u.origin; } catch { /* 요청 주소 이상 */ }
  const extra = String(env.WAITLIST_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(u.origin) ? u.origin : '';
}

export function cleanSignup(b) {
  const s = b && typeof b === 'object' ? b : {};
  if (s.hp) return { error: 'bot' }; // 사람에겐 안 보이는 칸
  const email = String(s.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return { error: 'bad_email' };
  if (s.privacy !== true || s.ad !== true) return { error: 'consent_required' };
  return {
    data: {
      email,
      src: String(s.src || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40),
      lang: ['ko', 'en', 'zh'].includes(s.lang) ? s.lang : 'ko',
      color: COLORS.includes(s.color) ? s.color : '',
      bundle: BUNDLES.includes(s.bundle) ? s.bundle : '',
    },
  };
}

async function ipHash(env, ip) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`waitlist|${env.SESSION_SECRET || ''}|${ip || ''}`));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function getCap(env) { const v = Number(await metaGet(env, 'waitlist_cap')); return v > 0 ? v : DEFAULT_CAP; }
export async function setCap(env, cap) { const n = Math.floor(Number(cap)); if (!(n >= 1 && n <= 100000)) throw fail(400, 'bad_cap'); await metaSet(env, 'waitlist_cap', n); return n; }

async function positionOf(d, n) { return (await d.prepare('SELECT COUNT(*) AS c FROM r_waitlist WHERE n <= ?').bind(n).first()).c; }

// 신청 — 있던 이메일이면 그 순번. 새로면 선착순 안인지 정해 넣는다. 같은 곳(IP)에서 10분 5건까지.
export async function join(env, data, { ip = '', now = Date.now() } = {}) {
  const d = await db(env);
  const cap = await getCap(env);
  const old = await d.prepare('SELECT n, id, earlybird FROM r_waitlist WHERE email=?').bind(data.email).first();
  if (old) return { position: await positionOf(d, old.n), earlybird: !!old.earlybird, already: true, ref: old.id, cap };
  const h = await ipHash(env, ip);
  const recent = await d.prepare('SELECT COUNT(*) AS c FROM r_waitlist WHERE ip=? AND created>?').bind(h, now - 600e3).first();
  if (recent.c >= 5) throw fail(429, 'too_many');
  const early = (await d.prepare('SELECT COUNT(*) AS c FROM r_waitlist WHERE earlybird=1').first()).c < cap;
  const id = newId('w').slice(0, 11);
  const r = await d.prepare('INSERT OR IGNORE INTO r_waitlist (id,email,src,lang,color,bundle,earlybird,ad,ip,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, data.email, data.src, data.lang, data.color, data.bundle, early ? 1 : 0, 1, h, now).run();
  if (!(r.meta && r.meta.changes)) return join(env, data, { ip, now }); // 같은 이메일이 동시에 — 있던 순번으로
  const row = await d.prepare('SELECT n FROM r_waitlist WHERE id=?').bind(id).first();
  return { position: await positionOf(d, row.n), earlybird: early, already: false, ref: id, cap };
}

export async function stats(env) {
  const d = await db(env);
  const cap = await getCap(env);
  const r = await d.prepare('SELECT COUNT(*) AS c, SUM(earlybird) AS e FROM r_waitlist').first();
  return { count: r.c || 0, cap, left: Math.max(0, cap - (r.e || 0)) };
}

const KST = 9 * 3600e3;
export async function summary(env) {
  const d = await db(env);
  const base = await stats(env);
  const group = async (col, empty) => (await d.prepare(`SELECT ${col} AS key, COUNT(*) AS n FROM r_waitlist GROUP BY ${col} ORDER BY n DESC, key LIMIT 40`).all()).results.map((x) => ({ key: x.key || empty, n: x.n }));
  const { results: days } = await d.prepare('SELECT created FROM r_waitlist WHERE created > ?').bind(Date.now() - 30 * 86400e3).all();
  const byDay = {};
  for (const r of days) { const k = new Date(r.created + KST).toISOString().slice(0, 10); byDay[k] = (byDay[k] || 0) + 1; }
  const { results: recent } = await d.prepare('SELECT n, email, src, lang, color, bundle, earlybird, created FROM r_waitlist ORDER BY n DESC LIMIT 50').all();
  return { ...base, bySrc: await group('src', '(바로)'), byColor: await group('color', '(고르지 않음)'), byBundle: await group('bundle', '(고르지 않음)'), byDay: Object.entries(byDay).sort().map(([key, n]) => ({ key, n })), recent };
}

const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export async function toCsv(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT n, email, src, lang, color, bundle, earlybird, ad, created FROM r_waitlist ORDER BY n').all();
  const head = '순번,이메일,출처,언어,컬러,구성,얼리버드,광고수신,신청시각(KST)';
  const rows = results.map((r, i) => [i + 1, r.email, r.src, r.lang, r.color, r.bundle, r.earlybird ? 'Y' : 'N', r.ad ? 'Y' : 'N', new Date(r.created + KST).toISOString().slice(0, 16).replace('T', ' ')].map(cell).join(','));
  return [head, ...rows].join('\n') + '\n';
}

// 지우기(시험 신청·본인 요청) — 이메일로
export async function remove(env, email) {
  const d = await db(env);
  const r = await d.prepare('DELETE FROM r_waitlist WHERE email=?').bind(String(email || '').trim().toLowerCase()).run();
  return (r.meta && r.meta.changes) || 0;
}
