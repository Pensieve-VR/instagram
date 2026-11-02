// 순수 로직 — 시간(KST)·슬롯·각도 순환·상태 전이·검증. Workers API를 쓰지 않아 node --test 로 그대로 검사한다.
export const KST = 9 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');

export function kstParts(ms) {
  const d = new Date(ms + KST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}
export const kstMs = (y, m, d, h = 0, min = 0) => Date.UTC(y, m, d, h, min) - KST;
export function dayStart(ms) { const p = kstParts(ms); return kstMs(p.y, p.m, p.d); }
export function dayKey(ms) { const p = kstParts(ms); return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`; }
export function weekStart(ms) { // 월요일 00:00 KST
  const p = kstParts(ms); const back = (p.dow + 6) % 7;
  return kstMs(p.y, p.m, p.d - back);
}
export const DAY = 86400e3;
export const hm = (ms) => { const p = kstParts(ms); return `${pad(p.h)}:${pad(p.min)}`; };

// 콘텐츠 각도 — 같은 소재라도 각도를 바꿔 쓴다. 적게 올리되 매번 다른 얼굴로.
export const ANGLES = [
  { key: 'feature', label: '기능 하나', hint: '기능 하나만 집어 그 기능이 바꾸는 순간을 보여 준다' },
  { key: 'problem', label: '문제 → 해결', hint: '고객이 겪는 구체적 불편 한 장면에서 시작해 해결로 끝낸다' },
  { key: 'compare', label: '비교', hint: '이전 방식 vs 지금 — 과장 없이 차이 하나' },
  { key: 'behind', label: '비하인드', hint: '만드는 과정·결정·실패담 — 사람 냄새' },
  { key: 'question', label: '질문 던지기', hint: '독자가 답하고 싶어지는 질문 하나로 대화를 연다' },
  { key: 'number', label: '수치', hint: '숫자 하나(출처가 있는 것만)로 말한다' },
  { key: 'scene', label: '사용 장면', hint: '누가 언제 어디서 쓰는지 한 장면' },
  { key: 'notice', label: '공지', hint: '사실만 — 출시·변경·일정' },
];
export const ANGLE_KEYS = ANGLES.map((a) => a.key);
export const angleLabel = (k) => (ANGLES.find((a) => a.key === k) || { label: k }).label;

export const DEFAULT_SETTINGS = {
  approval: 'review', // review: 승인 후 게시 · auto: 바로 예약
  ig: { slots: [{ dow: 2, hm: '20:00' }, { dow: 5, hm: '20:00' }] },            // 화·금 — 주 2회, 적게 잘
  th: { slots: [1, 2, 3, 4, 5].map((dow) => ({ dow, hm: '12:30' })) },           // 평일 하루 1회
  angles: ANGLE_KEYS,
  boost: { enabled: false, daily: 10000 },
  tone: '',
};

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function cleanSlots(v, fallback) {
  if (!Array.isArray(v)) return fallback;
  const out = v
    .map((s) => ({ dow: Number(s && s.dow), hm: String((s && s.hm) || '') }))
    .filter((s) => Number.isInteger(s.dow) && s.dow >= 0 && s.dow <= 6 && HM_RE.test(s.hm));
  const seen = new Set();
  return out.filter((s) => { const k = `${s.dow}|${s.hm}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.dow - b.dow || a.hm.localeCompare(b.hm)).slice(0, 21);
}
export function mergeSettings(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const angles = Array.isArray(s.angles) ? s.angles.filter((k) => ANGLE_KEYS.includes(k)) : [];
  const out = {
    approval: s.approval === 'auto' ? 'auto' : 'review',
    ig: { slots: cleanSlots(s.ig && s.ig.slots, DEFAULT_SETTINGS.ig.slots) },
    th: { slots: cleanSlots(s.th && s.th.slots, DEFAULT_SETTINGS.th.slots) },
    angles: angles.length ? angles : ANGLE_KEYS,
    boost: { enabled: !!(s.boost && s.boost.enabled), daily: Math.min(1000000, Math.max(0, Number(s.boost && s.boost.daily) || 10000)) },
    tone: String(s.tone || '').slice(0, 400),
  };
  // 프로필(소개문·모노그램)은 설정에 얹혀 있다 — 있을 때만 모양을 맞춰 들고 간다
  if (s.profile && typeof s.profile === 'object') {
    out.profile = {
      bio: String(s.profile.bio || '').slice(0, 150),
      link_text: String(s.profile.link_text || '').slice(0, 20),
      monogram: String(s.profile.monogram || '').slice(0, 2),
      palette: ['rose', 'navy', 'teal', 'ochre', 'violet'].includes(s.profile.palette) ? s.profile.palette : 'rose',
    };
  }
  return out;
}

// 슬롯 → (from, until] 사이의 시각들(ms). taken 에 든 시각(분 단위)은 건너뛴다.
export function nextSlots(slots, fromMs, untilMs, taken = new Set()) {
  const out = [];
  if (!Array.isArray(slots) || !slots.length || !(untilMs > fromMs)) return out;
  for (let day = dayStart(fromMs); day <= untilMs; day += DAY) {
    const dow = kstParts(day).dow;
    for (const s of slots) {
      if (s.dow !== dow) continue;
      const [h, min] = s.hm.split(':').map(Number);
      const t = day + h * 3600e3 + min * 60e3;
      if (t > fromMs && t <= untilMs && !taken.has(t)) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

// 각도 순환 — 가장 오래 안 쓴 각도. recent 는 오래된 것 → 최근 순.
export function pickAngle(recent, allowed = ANGLE_KEYS) {
  const list = (Array.isArray(allowed) && allowed.length ? allowed : ANGLE_KEYS).filter((k) => ANGLE_KEYS.includes(k));
  if (!list.length) return ANGLE_KEYS[0];
  let best = list[0]; let bestIdx = Infinity;
  for (const k of list) {
    const idx = Array.isArray(recent) ? recent.lastIndexOf(k) : -1;
    if (idx < bestIdx) { bestIdx = idx; best = k; }
  }
  return best;
}

export const STATES = ['draft', 'review', 'scheduled', 'publishing', 'posted', 'failed', 'skipped'];
export const MAX_ATTEMPTS = 3;
// 허용되지 않은 전이는 null — 호출자가 거절한다(조용히 바꾸지 않는다).
export function transition(state, action, ctx = {}) {
  const attempts = Number(ctx.attempts) || 0;
  switch (action) {
    case 'approve': return ['draft', 'review', 'failed'].includes(state) ? 'scheduled' : null;
    case 'hold': return state === 'scheduled' ? 'review' : null;
    case 'skip': return ['draft', 'review', 'scheduled', 'failed'].includes(state) ? 'skipped' : null;
    case 'start': return state === 'scheduled' ? 'publishing' : null;
    case 'posted': return state === 'publishing' ? 'posted' : null;
    case 'fail': return state === 'publishing' ? (attempts < MAX_ATTEMPTS ? 'scheduled' : 'failed') : null;
    case 'retry': return state === 'failed' ? 'scheduled' : null;
    default: return null;
  }
}
export const isDue = (post, nowMs) => post.state === 'scheduled' && post.scheduled_at > 0 && post.scheduled_at <= nowMs;

// Instagram 사용자 이름 규칙: 1~30자, 영문 소문자·숫자·마침표·밑줄, 마침표로 시작·끝 금지, 연속 마침표 금지
export const HANDLE_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._]{1,30}$(?<!\.)/;
export const cleanHandle = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');
export const validHandle = (v) => HANDLE_RE.test(cleanHandle(v));

export const LIMITS = { igCaption: 2200, thText: 500, igTags: 5, hook: 60 };
export function clip(text, n) { const s = String(text || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
export function cleanTags(v, max = LIMITS.igTags) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  const out = [];
  for (const t of arr) {
    const k = String(t || '').trim().replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

// 오늘의 신호 — 화면 모서리에만 뜨는 것. 글이 아니라 색으로.
export function signals({ channels = [], posts = [], nowMs = Date.now() }) {
  const out = [];
  for (const c of channels) {
    if (!c.hasToken) { out.push({ level: 'bad', kind: 'unlinked', channel: c.kind, text: `${c.kind === 'ig' ? 'Instagram' : 'Threads'} 연결 안 됨` }); continue; }
    if (c.status === 'expired') { out.push({ level: 'bad', kind: 'expired', channel: c.kind, text: `${c.kind === 'ig' ? 'Instagram' : 'Threads'} 토큰 만료 — 다시 연결` }); continue; }
    const left = Math.floor((c.token_exp - nowMs) / DAY);
    if (c.token_exp && left <= 7) out.push({ level: 'warn', kind: 'token', channel: c.kind, text: `${c.kind === 'ig' ? 'Instagram' : 'Threads'} 토큰 D-${Math.max(0, left)}` });
  }
  const failed = posts.filter((p) => p.state === 'failed').length;
  if (failed) out.push({ level: 'bad', kind: 'failed', text: `게시 실패 ${failed}` });
  const review = posts.filter((p) => p.state === 'review').length;
  if (review) out.push({ level: 'warn', kind: 'review', text: `승인 대기 ${review}` });
  if (!out.length) out.push({ level: 'ok', kind: 'ok', text: '두 노선 정상' });
  return out;
}
