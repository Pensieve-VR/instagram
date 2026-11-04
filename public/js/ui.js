// 작은 도우미 — 요소 만들기 · 토스트 · 겹창 · 시간 글자. 글은 최소, 전환으로 말한다.
export function el(tag, attrs = {}, ...children) {
  const node = tag.startsWith('svg:') ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) { if (c == null || c === false) continue; node.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return node;
}
export const svgEl = (tag, attrs, ...children) => el('svg:' + tag, attrs, ...children);

let toastTimer;
export function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 3200 : 1800);
}

export function busy(btn, on) { if (!btn) return; btn.classList.toggle('busy', !!on); btn.disabled = !!on; }
export async function withBusy(btn, fn) { busy(btn, true); try { return await fn(); } finally { busy(btn, false); } }


export async function copyText(s) {
  try { await navigator.clipboard.writeText(s); toast('복사했습니다'); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = s; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove();
    toast(ok ? '복사했습니다' : '복사가 막혔습니다 — 직접 선택해 주세요', !ok); return ok;
  }
}

export const KST = 9 * 3600e3;
export const DAY = 86400e3;
const pad = (n) => String(n).padStart(2, '0');
export function kst(ms) { const d = new Date(ms + KST); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() }; }
export const kstMs = (y, m, d, h = 0, min = 0) => Date.UTC(y, m, d, h, min) - KST;
export function weekStart(ms) { const p = kst(ms); return kstMs(p.y, p.m, p.d - (p.dow + 6) % 7); }
export const DOW = ['일', '월', '화', '수', '목', '금', '토'];
export const hm = (ms) => { const p = kst(ms); return `${pad(p.h)}:${pad(p.min)}`; };
export const md = (ms) => { const p = kst(ms); return `${p.m + 1}.${p.d}`; };
export const dowOf = (ms) => DOW[kst(ms).dow];
export const whenText = (ms) => `${md(ms)} (${dowOf(ms)}) ${hm(ms)}`;
export function toLocalInput(ms) { const p = kst(ms); return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`; }
export function fromLocalInput(v) { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!m) return null; return kstMs(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); }
export function ago(ms) { const s = Math.max(0, (Date.now() - ms) / 1000); if (s < 60) return '방금'; if (s < 3600) return `${Math.floor(s / 60)}분 전`; if (s < 86400) return `${Math.floor(s / 3600)}시간 전`; return `${Math.floor(s / 86400)}일 전`; }

export const STATE_LABEL = { review: '내 차례', scheduled: '예약', publishing: '올리는 중', posted: '올라감', failed: '실패', skipped: '건너뜀' };
export const PLAT = { ig: 'IG', th: 'TH', x: 'X' };
export const PLAT_NAME = { ig: 'Instagram', th: 'Threads', x: 'X' };
export const lineLabel = (a) => `${PLAT[a.platform] || a.platform} ${String(a.lang || '').toUpperCase()}`;
// 계정 색 — 플랫폼·언어로 고정. 같은 조합이 또 있으면 남는 색
export function lineColors(accounts) {
  const base = { 'ig-ko': '--l-igko', 'th-ko': '--l-thko', 'ig-en': '--l-igen', 'th-en': '--l-then', 'x-en': '--l-x', 'x-ko': '--l-x' };
  const used = new Set(); const out = {};
  for (const a of accounts) {
    let v = base[`${a.platform}-${a.lang}`];
    if (!v || used.has(v)) v = '--l-more';
    used.add(v); out[a.id] = `var(${v})`;
  }
  return out;
}
export const WORDMARK = '<svg class="wm" viewBox="0 0 418 152" fill="none" aria-label="rené."><g stroke-width="17" stroke-linecap="round" stroke-linejoin="round"><path d="M22 127V61M22 88C25 62 47 52 66 62"/><path d="M98 91H160C161 49 96 47 96 91C96 126 131 140 160 119"/><path d="M194 127V61M194 88C194 49 255 49 255 88V127"/><path d="M291 91H353C354 49 289 47 289 91C289 126 324 140 353 119"/><path d="M318 32L336 16"/></g><circle cx="392" cy="123" r="13"/></svg>';
export const ICON = {
  lib: '<path d="M4 4h7v8H4zM13 4h7v8h-7zM4 15h16v5H4z"/>',
  lines: '<path d="M3 8h18M3 16h18"/><circle cx="8" cy="8" r="2.4"/><circle cx="16" cy="16" r="2.4"/>',
  brand: '<path d="M5 19c0-8 5-14 14-14 0 9-6 14-14 14z"/><path d="M5 19l7-7"/>',
  moon: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/>',
  out: '<path d="M10 17l5-5-5-5M15 12H3M13 3h6v18h-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  left: '<path d="M15 6l-6 6 6 6"/>', right: '<path d="M9 6l6 6-6 6"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 14.2c2.8.2 5 2.6 5 5.8"/>',
};
export const icon = (k) => el('svg:svg', { class: 'ic', viewBox: '0 0 24 24', html: ICON[k] });
