// 노선도 — 계정마다 한 줄, 게시물은 시간 위치의 역. 같은 글감은 환승(굵은 회색 띠)으로 잇는다.
import { svgEl, kst, DAY, DOW, lineLabel } from './ui.js';

const L = 100; const R = 30; const TOP = 76; const GAP = 66; const MIN_W = 760;

// opts: { accounts, posts, from, now, colors, selected, prev(Map id→state) } · on: { station(id, pos), term(accId), blank() }
export function drawMap(root, opts, on) {
  const { accounts, posts, from, now, colors, selected, prev } = opts;
  const W = Math.max(root.clientWidth || MIN_W, MIN_W);
  const H = TOP + accounts.length * GAP + 4;
  const dayW = (W - L - R) / 7;
  const X = (t) => L + ((t - from) / DAY) * dayW;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '노선도 — 계정마다 한 줄, 게시물은 역' });
  svg.addEventListener('click', (e) => { if (e.target === svg || e.target.classList.contains('bgc')) on.blank(); });
  svg.append(svgEl('rect', { class: 'bgc', x: 0, y: 0, width: W, height: H, fill: 'transparent' }));

  // 날짜
  const today = kst(now);
  for (let i = 0; i < 7; i++) {
    const t = from + i * DAY; const p = kst(t);
    const isToday = p.y === today.y && p.m === today.m && p.d === today.d;
    const cx = L + (i + 0.5) * dayW;
    svg.append(svgEl('text', { class: 'day' + (isToday ? ' today' : ''), x: cx, y: 30, 'text-anchor': 'middle' }, `${DOW[p.dow]} ${p.d}`));
    if (i > 0) svg.append(svgEl('line', { class: 'gridl', x1: L + i * dayW, y1: 44, x2: L + i * dayW, y2: H - 4 }));
  }
  if (now >= from && now < from + 7 * DAY) {
    const nx = X(now);
    svg.append(svgEl('line', { class: 'nowl', x1: nx, y1: 46, x2: nx, y2: H - 4 }), svgEl('circle', { class: 'nowd', cx: nx, cy: 46, r: 5 }));
  }

  // 역 자리 — 같은 줄에서 26px 안으로 붙으면 옆으로 민다(고정 3장처럼 5분 간격)
  const rowOf = new Map(accounts.map((a, i) => [a.id, i]));
  const pos = new Map();
  for (const a of accounts) {
    let last = -1e9;
    for (const p of posts.filter((x) => x.account_id === a.id).sort((x, y) => x.scheduled_at - y.scheduled_at)) {
      let x = Math.max(L + 14, Math.min(W - R + 6, X(p.scheduled_at)));
      if (x - last < 26) x = last + 26;
      last = x;
      pos.set(p.id, { x, y: TOP + rowOf.get(a.id) * GAP });
    }
  }

  // 줄
  const has = new Set(posts.map((p) => p.account_id));
  const lanes = svgEl('g'); const xfers = svgEl('g'); const stations = svgEl('g');
  // 줄 이름표는 따로 — 좁은 화면에서 옆으로 밀어도 왼쪽에 붙어 있게(sticky)
  const terms = svgEl('svg', { class: 'terms', width: L - 4, height: H, viewBox: `0 0 ${L - 4} ${H}` });
  accounts.forEach((a, i) => {
    const y = TOP + i * GAP; const c = colors[a.id];
    const linked = a.status === 'linked';
    if (linked) lanes.append(svgEl('path', { class: 'lane', d: `M${L - 10} ${y}H${W - R + 14}`, style: `stroke:${c}` }));
    else lanes.append(svgEl('path', { class: 'lane plan', d: `M${L - 6} ${y}H${has.has(a.id) ? W - R + 14 : L + 150}`, style: `stroke:${c}` }));
    const g = svgEl('g', { class: 'term', tabindex: 0, role: 'button', 'aria-label': `${lineLabel(a)} 줄 설정` });
    const w = 74; const x0 = 14;
    const exp = a.status === 'expired';
    g.append(svgEl('rect', { x: x0, y: y - 13, width: w, height: 26, rx: 13, style: linked ? `fill:${c}` : `fill:var(--paper);stroke:${exp ? 'var(--bad)' : c};stroke-width:1.5;stroke-dasharray:${exp ? '0' : '4 3'}` }));
    g.append(svgEl('text', { x: x0 + w / 2, y: y + 4, 'text-anchor': 'middle', style: `fill:${linked ? 'var(--on-ink)' : exp ? 'var(--bad)' : c}` }, lineLabel(a)));
    g.addEventListener('click', () => on.term(a.id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter') on.term(a.id); });
    terms.append(g);
  });

  // 환승 — 같은 글감, 두 줄 이상
  const ideas = new Map();
  for (const p of posts) if (p.idea_id && pos.has(p.id) && p.state !== 'skipped') ideas.set(p.idea_id, [...(ideas.get(p.idea_id) || []), p]);
  for (const list of ideas.values()) {
    const pts = list.map((p) => pos.get(p.id)).sort((a, b) => a.y - b.y);
    if (new Set(pts.map((p) => p.y)).size < 2) continue;
    const spread = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    // 같은 날 근처면 굵은 띠(환승역), 멀면 가는 점선 — 노선도를 가로지르는 큰 띠가 생기지 않게
    xfers.append(svgEl('path', { class: spread > dayW * 0.6 ? 'xfer far' : 'xfer', d: pts.map((p, k) => `${k ? 'L' : 'M'}${p.x} ${p.y}`).join('') }));
  }

  // 역
  for (const p of posts) {
    const at = pos.get(p.id); if (!at) continue;
    const c = colors[p.account_id];
    const was = prev && prev.get(p.id);
    const anim = !prev || !prev.size ? '' : !was ? ' pop-in' : was !== p.state && p.state === 'posted' ? ' fill-in' : was !== p.state && p.state === 'failed' ? ' shake' : '';
    const g = svgEl('g', { class: 'st' + (p.id === selected ? ' sel' : '') + anim, tabindex: 0, role: 'button', 'data-id': p.id, 'aria-label': `${p.title || '게시물'} — ${p.state}` });
    const { x, y } = at;
    if (p.state === 'review') g.append(svgEl('circle', { class: 'halo', cx: x, cy: y, r: 12 }), svgEl('circle', { cx: x, cy: y, r: 12.5, style: 'fill:var(--amber);stroke:var(--sheet);stroke-width:3' }));
    else if (p.state === 'scheduled') g.append(svgEl('circle', { cx: x, cy: y, r: 11, style: `fill:var(--sheet);stroke:${c};stroke-width:5` }));
    else if (p.state === 'publishing') g.append(svgEl('circle', { cx: x, cy: y, r: 11, style: `fill:var(--sheet);stroke:${c};stroke-width:5;stroke-dasharray:5 4` }), svgEl('circle', { cx: x, cy: y, r: 4, style: 'fill:var(--led)' }));
    else if (p.state === 'posted') g.append(svgEl('circle', { cx: x, cy: y, r: 12.5, style: `fill:${c};stroke:var(--sheet);stroke-width:3` }));
    else if (p.state === 'failed') g.append(svgEl('circle', { cx: x, cy: y, r: 11, style: 'fill:var(--sheet);stroke:var(--bad);stroke-width:5' }));
    else g.append(svgEl('circle', { cx: x, cy: y, r: 7, style: 'fill:var(--paper);stroke:var(--ink3);stroke-width:1.5;opacity:.6' })); // 건너뜀
    if (p.format !== 'text' && p.media && p.media.length > 1) g.append(svgEl('circle', { cx: x + 12, cy: y - 12, r: 3.2, style: `fill:${c};stroke:var(--sheet);stroke-width:1.5` })); // 여러 장
    const go = () => on.station(p.id, at);
    g.addEventListener('click', (e) => { e.stopPropagation(); go(); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    stations.append(g);
  }
  svg.append(lanes, xfers, stations);
  return { svg, terms, pos, width: W, nowX: X(now) };
}
