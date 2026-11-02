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

const layer = () => document.getElementById('layer');
export function openModal(content, { narrow = false, onClose } = {}) {
  const L = layer(); L.innerHTML = ''; L.hidden = false;
  const box = el('div', { class: 'modal' + (narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true' });
  const x = el('button', { class: 'icon-btn x', type: 'button', 'aria-label': '닫기', onclick: () => closeModal() }, iconX());
  box.append(x, content);
  L.append(box);
  L.onclick = (e) => { if (e.target === L) closeModal(); };
  const esc = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', esc);
  L._cleanup = () => { document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  setTimeout(() => { const f = box.querySelector('textarea, input, button:not(.x)'); if (f) f.focus(); }, 50);
  return box;
}
export function closeModal() { const L = layer(); if (L.hidden) return; L.hidden = true; L.innerHTML = ''; if (L._cleanup) { L._cleanup(); L._cleanup = null; } }
export const modalOpen = () => !layer().hidden;

export function iconX() { return el('svg:svg', { class: 'ic', viewBox: '0 0 24 24', html: '<path d="M6 6l12 12M18 6L6 18"/>' }); }

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

export const STATE_LABEL = { draft: '초안', review: '승인 대기', scheduled: '예약', publishing: '게시 중', posted: '게시됨', failed: '실패', skipped: '건너뜀' };
export const ANGLE_LABEL = { feature: '기능 하나', problem: '문제 → 해결', compare: '비교', behind: '비하인드', question: '질문 던지기', number: '수치', scene: '사용 장면', notice: '공지' };
export const KIND_NAME = { ig: 'Instagram', th: 'Threads' };
