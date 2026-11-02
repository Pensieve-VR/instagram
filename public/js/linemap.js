// 주간 노선도 — 위 Instagram, 아래 Threads. 역의 모양이 상태다: 점선 초안 · 형광 승인 대기 · 빈 원 예약 · 채운 원 게시됨 · 붉은 원 실패.
import { svgEl, el, kst, DAY, DOW, hm, STATE_LABEL } from './ui.js';

const W = 1000, LEFT = 86, RIGHT = 48, TOP = 38, RAIL_Y = { ig: 118, th: 232 }, H = 300;
const colW = (W - LEFT - RIGHT) / 7;
const clipName = (s, n = 11) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function renderWeekMap({ weekStart, posts, channels, now, onStation, onPlus }) {
  const svg = svgEl('svg', { class: 'wm', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '이번 주 노선도' });
  const xOf = (ms) => { const idx = Math.floor((ms - weekStart) / DAY); const p = kst(ms); const frac = (p.h * 60 + p.min) / 1440; return LEFT + idx * colW + colW * 0.14 + frac * colW * 0.72; };
  const todayIdx = Math.floor((now - weekStart) / DAY);
  // 날짜 머리 + 격자
  for (let i = 0; i < 7; i++) {
    const dayMs = weekStart + i * DAY; const p = kst(dayMs); const cx = LEFT + i * colW + colW / 2;
    svg.append(svgEl('text', { x: cx, y: TOP - 16, 'text-anchor': 'middle', class: 'day' + (i === todayIdx ? ' today' : '') }, DOW[p.dow]));
    svg.append(svgEl('text', { x: cx, y: TOP - 2, 'text-anchor': 'middle', class: 'daynum' }, `${p.m + 1}.${p.d}`));
    if (i > 0) svg.append(svgEl('line', { x1: LEFT + i * colW, y1: TOP + 6, x2: LEFT + i * colW, y2: H - 18, class: 'grid' }));
  }
  if (todayIdx >= 0 && todayIdx < 7) { const x = xOf(now); svg.append(svgEl('line', { x1: x, y1: TOP + 4, x2: x, y2: H - 16, class: 'todayline' })); }
  const linked = Object.fromEntries(['ig', 'th'].map((k) => [k, channels.some((c) => c.kind === k && c.hasToken && c.status === 'linked')]));
  for (const kind of ['ig', 'th']) {
    const y = RAIL_Y[kind];
    svg.append(svgEl('text', { x: 16, y: y + 4, class: 'railname' }, kind === 'ig' ? 'INSTAGRAM' : 'THREADS'));
    svg.append(svgEl('path', { d: `M${LEFT} ${y}H${W - RIGHT}`, class: `rail ${kind}${linked[kind] ? '' : ' off'}` }));
    // 역
    const mine = posts.filter((p) => p.channel === kind && p.scheduled_at >= weekStart && p.scheduled_at < weekStart + 7 * DAY).sort((a, b) => a.scheduled_at - b.scheduled_at);
    let lastX = -Infinity; let flip = 0;
    for (const p of mine) {
      const x = xOf(p.scheduled_at);
      if (x - lastX < 46) flip = 1 - flip; else flip = 0; // 붙어 있으면 이름을 위아래로 번갈아
      lastX = x;
      const r = kind === 'ig' ? 10 : 8;
      const g = svgEl('g', { class: `st ${kind} ${p.state}${p.state === 'review' ? ' halo' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${hm(p.scheduled_at)} ${STATE_LABEL[p.state] || p.state} ${p.hook}` });
      g.append(svgEl('title', {}, `${hm(p.scheduled_at)} · ${STATE_LABEL[p.state] || p.state}\n${p.hook}`));
      g.append(svgEl('circle', { cx: x, cy: y, r }));
      const nameY = flip ? y + r + 26 : y - r - 14;
      const timeY = flip ? y + r + 14 : y - r - 28;
      if (kind === 'ig' || mine.length <= 7) svg.append(svgEl('text', { x, y: nameY, 'text-anchor': 'middle', class: 'name' }, clipName(p.hook, kind === 'ig' ? 12 : 9)));
      svg.append(svgEl('text', { x, y: timeY, 'text-anchor': 'middle', class: 'time' }, hm(p.scheduled_at)));
      if (p.state === 'posted' && (p.metrics.likes || p.metrics.views)) svg.append(svgEl('text', { x, y: flip ? y - r - 10 : y + r + 16, 'text-anchor': 'middle', class: 'metric' }, p.metrics.views ? `${p.metrics.views} 뷰` : `♥ ${p.metrics.likes}`));
      g.addEventListener('click', () => onStation(p));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStation(p); } });
      svg.append(g);
    }
    // 끝의 + : 이 노선 채우기
    if (linked[kind] && onPlus) {
      const g = svgEl('g', { class: 'plus', tabindex: '0', role: 'button', 'aria-label': `${kind === 'ig' ? 'Instagram' : 'Threads'} 노선 채우기` });
      g.append(svgEl('title', {}, '이 노선 채우기'));
      g.append(svgEl('circle', { cx: W - RIGHT + 18, cy: y, r: 11 }));
      g.append(svgEl('path', { d: `M${W - RIGHT + 13} ${y}h10M${W - RIGHT + 18} ${y - 5}v10` }));
      g.addEventListener('click', () => onPlus(kind, g));
      svg.append(g);
    }
  }
  return svg;
}

export function emptyOverlay(text, onClick) {
  const wrap = el('div', { class: 'empty-map' });
  wrap.append(el('button', { class: 'pill', type: 'button', onclick: onClick }, text));
  return wrap;
}
