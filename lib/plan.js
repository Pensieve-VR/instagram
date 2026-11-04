// 순수 로직 — 시간(KST)·형식·검증·상태 전이·시간 제안·브랜드 시트. Workers API 를 쓰지 않아 node --test 로 그대로 검사한다.
export const KST = 9 * 3600e3;
export const DAY = 86400e3;
const pad = (n) => String(n).padStart(2, '0');

export function kstParts(ms) {
  const d = new Date(ms + KST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}
export const kstMs = (y, m, d, h = 0, min = 0) => Date.UTC(y, m, d, h, min) - KST;
export function dayStart(ms) { const p = kstParts(ms); return kstMs(p.y, p.m, p.d); }
export function dayKey(ms) { const p = kstParts(ms); return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`; }
export function weekStart(ms) { const p = kstParts(ms); return kstMs(p.y, p.m, p.d - (p.dow + 6) % 7); } // 월요일 00:00 KST
export const hm = (ms) => { const p = kstParts(ms); return `${pad(p.h)}:${pad(p.min)}`; };

// ---------- 형식 ----------
// min/max = 장 수, img/vid = 받는 종류. 글자 수는 LIMITS.
export const FORMATS = {
  ig: {
    image: { min: 1, max: 1, img: true, vid: false, label: '사진' },
    carousel: { min: 2, max: 20, img: true, vid: true, label: '캐러셀' },
    reel: { min: 1, max: 1, img: false, vid: true, label: '릴스' },
    story: { min: 1, max: 1, img: true, vid: true, label: '스토리' },
  },
  th: {
    text: { min: 0, max: 0, img: false, vid: false, label: '글' },
    image: { min: 1, max: 1, img: true, vid: false, label: '사진' },
    video: { min: 1, max: 1, img: false, vid: true, label: '영상' },
    carousel: { min: 2, max: 20, img: true, vid: true, label: '캐러셀' },
  },
  x: {
    text: { min: 0, max: 0, img: false, vid: false, label: '글' },
    image: { min: 1, max: 4, img: true, vid: false, label: '사진' },
    thread: { min: 0, max: 4, img: true, vid: false, label: '스레드' },
  },
};
export const LIMITS = { caption: { ig: 2200, th: 500, x: 280 }, reply: { ig: 2200, th: 500, x: 280 }, tags: 30, daily: { ig: 100, th: 250, x: 100 } };
export const SLOT = { ig: '20:00', th: '12:30', x: '09:00' }; // 계정 기본 시간대(KST)
export const PLATFORM_NAME = { ig: 'Instagram', th: 'Threads', x: 'X' };

// 승인 전에 막을 것들 — 사람이 읽는 짧은 말. 빈 배열이면 올릴 수 있다.
export function problems(post, account, now = 0) {
  const out = [];
  if (!account) return ['계정이 없습니다'];
  const f = (FORMATS[account.platform] || {})[post.format];
  if (!f) return [`${PLATFORM_NAME[account.platform] || account.platform}에 없는 형식`];
  if (account.status !== 'linked') out.push(account.status === 'expired' ? '계정 연결이 만료됨 — 다시 연결' : '계정 연결 전');
  const media = Array.isArray(post.media) ? post.media : [];
  if (media.length < f.min) out.push(f.min === 1 ? (f.vid && !f.img ? '영상이 필요합니다' : '사진이 필요합니다') : `${f.min}장 이상 필요`);
  if (media.length > f.max) out.push(f.max === 0 ? '글만 올리는 형식 — 사진을 빼 주세요' : `${f.max}장까지`);
  if (!f.vid && media.some((m) => m.kind === 'video')) out.push('사진만 넣을 수 있습니다');
  if (!f.img && media.some((m) => m.kind === 'image')) out.push('영상만 넣을 수 있습니다');
  if (media.some((m) => !m.key && !m.url)) out.push('이미지가 아직 없습니다 — 다시 찍기');
  const cap = String(post.caption || '');
  const lim = LIMITS.caption[account.platform];
  if (composeCaption(post, account.platform).length > lim) out.push(`글이 ${lim}자를 넘습니다`);
  if ((post.format === 'text' || post.format === 'thread') && !cap.trim()) out.push('글이 비어 있습니다');
  if (String(post.first_reply || '').length > LIMITS.reply[account.platform]) out.push(`첫 댓글이 ${LIMITS.reply[account.platform]}자를 넘습니다`);
  // 승인을 기다리는 사이 시간이 지나면 — 승인하는 순간 바로 올라가지 않게 시간을 다시 고르게 한다
  if (now && post.state === 'review' && post.scheduled_at > 0 && post.scheduled_at < now - 60e3) out.push('시간이 지났습니다 — 시간을 다시 고르기');
  return out;
}

// ---------- 상태 ----------
// review(내 차례) → scheduled(예약) → publishing(올리는 중) → posted(올라감) | failed(실패). skipped(건너뜀).
// publishing·posted 는 시스템만 바꾼다.
const MOVES = {
  review: { approve: 'scheduled', skip: 'skipped' },
  scheduled: { hold: 'review', skip: 'skipped' },
  failed: { retry: 'scheduled', hold: 'review', skip: 'skipped' },
  skipped: { restore: 'review' },
};
export const transition = (state, action) => (MOVES[state] && MOVES[state][action]) || null;
export const isDue = (post, now) => post.state === 'scheduled' && post.scheduled_at > 0 && post.scheduled_at <= now;

// ---------- 시간 제안 ----------
// 계정마다 하루 하나, 그 계정 시간대(slot, 없으면 플랫폼 기본). 1시간 안쪽으로 다가온 오늘 자리는 건너뛴다.
// pinned(고정 게시물)가 이어지면 같은 날 5분 간격. at 이 이미 있는 항목은 그대로.
function slotMin(account) {
  const s = (account && account.slot) || SLOT[account && account.platform] || '20:00';
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 20 * 60;
}
export function suggestTimes(items, { accounts, existing = [], now }) {
  const taken = {}; // account → Set(dayKey)
  const mark = (a, ms) => { (taken[a] ||= new Set()).add(dayKey(ms)); };
  for (const e of existing) if (e.scheduled_at > 0) mark(e.account_id, e.scheduled_at);
  for (const it of items) if (it.at > 0) mark(it.account_id, it.at);
  const lastPinned = {};
  return items.map((it) => {
    if (it.at > 0) return it.at;
    const acc = accounts[it.account_id];
    if (it.pinned && lastPinned[it.account_id]) { const t = lastPinned[it.account_id] + 5 * 60e3; lastPinned[it.account_id] = t; return t; }
    const mins = slotMin(acc);
    const p = kstParts(now);
    for (let i = 0; i < 400; i++) {
      const t = kstMs(p.y, p.m, p.d + i, Math.floor(mins / 60), mins % 60);
      if (t < now + 3600e3) continue;
      if (taken[it.account_id] && taken[it.account_id].has(dayKey(t))) continue;
      mark(it.account_id, t);
      if (it.pinned) lastPinned[it.account_id] = t; else delete lastPinned[it.account_id];
      return t;
    }
    return now + DAY;
  });
}

// ---------- 글 ----------
export function clip(s, n) { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
export function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  const out = [];
  for (const t of list) {
    const c = String(t || '').replace(/[#\s]/g, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, LIMITS.tags);
}
// 실제로 올라갈 글 — Instagram 만 해시태그를 끝에 붙인다
export function composeCaption(post, platform) {
  const text = String(post.caption || '').trim();
  if (platform !== 'ig') return text;
  const tags = cleanTags(post.hashtags).map((t) => '#' + t).join(' ');
  return tags ? (text ? `${text}\n\n${tags}` : tags) : text;
}

// ---------- 브랜드 시트 ----------
// Claude 는 여기 적힌 사실만 쓴다. 숫자·약속은 시트에 없으면 만들지 않는다.
export const DEFAULT_BRAND = {
  name: '르네 (rené.)',
  oneliner: '일하는 당신 곁의 작은 AI 펫',
  facts: [
    '르네는 책상 위에 두는 작은 AI 펫이다 — 보고, 듣고, Claude·Codex로 이어 준다',
    '대화와 작업의 맥락을 담아 두었다가 읽어 준다',
    '카메라(눈)로 종이·화면·물건을 직접 보고 그걸로 대화한다',
    '쓰던 Claude·Codex와 연결해 누가 일하는 중인지, 누가 부르는지 불빛으로 보여 준다 — 탭을 넘겨 확인할 필요가 줄어든다',
    '평소엔 조용히 졸다가 누르면 바로 일한다 · 표정은 커버를 갈아 끼워 바꾼다',
    '상시 촬영·녹음은 없다 — 버튼을 누를 때만 기록하고, 카메라는 손으로 여닫는 셔터라 닫으면 못 본다',
    '아직 개발 중 — 지금은 구매 대기(얼리버드) 명단을 받는다. 명단에 들면 출시 때 10% 할인 코드를 메일로 보낸다',
    '출시 예정가 189,000원, 얼리버드 10% 할인가 170,100원(개발 중이라 바뀔 수 있음 — 한국어 계정에서만 언급)',
    '댓글에 「르네」(영어 계정은 RENE)를 남기면 얼리버드 링크를 DM으로 보낸다',
  ],
  banned: ['품절', '선착순 인원 숫자', '출시일 확정', '영어 계정의 가격', '효능·성능 과장', '경쟁사 비방'],
  tone: '짧고 담백하게. 첫 줄이 후킹. 이모지는 거의 쓰지 않는다. 한국어는 해요체, 영어는 가볍고 위트 있게.',
  kw: { ko: '르네', en: 'RENE' },
  link: 'https://www.pensieve.kr/early',
  tags: { ko: ['르네', 'AI펫', 'AI디바이스', '데스크테리어', '클로드코드', '코덱스'], en: ['rene', 'aipet', 'desksetup', 'aidevice', 'claudecode', 'codex'] },
};
const lines = (v, fallback, max = 30, len = 300) => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : null;
  if (!arr) return fallback;
  return arr.map((s) => String(s || '').trim().slice(0, len)).filter(Boolean).slice(0, max);
};
export function normalizeBrand(b) {
  const s = b && typeof b === 'object' ? b : {};
  const D = DEFAULT_BRAND;
  let link = String(s.link ?? D.link).trim().slice(0, 300);
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  return {
    name: String(s.name ?? D.name).slice(0, 60),
    oneliner: String(s.oneliner ?? D.oneliner).slice(0, 120),
    facts: lines(s.facts, D.facts),
    banned: lines(s.banned, D.banned, 30, 80),
    tone: String(s.tone ?? D.tone).slice(0, 600),
    kw: { ko: String((s.kw && s.kw.ko) || D.kw.ko).slice(0, 20), en: String((s.kw && s.kw.en) || D.kw.en).slice(0, 20) },
    link,
    tags: { ko: cleanTags((s.tags && s.tags.ko) ?? D.tags.ko), en: cleanTags((s.tags && s.tags.en) ?? D.tags.en) },
  };
}
