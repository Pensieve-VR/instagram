// 르네 콘솔 — 첫 화면은 노선도 하나. 나머지(만들기·역·보관함·채널·브랜드)는 그 위로 올라오는 시트.
import { api, API, authed, clearAuth } from './api.js';
import { el, toast, busy, kst, kstMs, weekStart, DAY, DOW, hm, md, whenText, toLocalInput, fromLocalInput, ago, STATE_LABEL, PLAT_NAME, lineLabel, lineColors, WORDMARK, icon } from './ui.js';
import { drawMap } from './map.js';
import { groupFiles } from './folder.js';

const $ = (id) => document.getElementById(id);
const S = { data: null, week: 0, sel: '', sheet: null, prev: new Map(), focusLine: '', igList: null, events: null, pick: null, importing: null };
const LIMIT = { ig: 2200, th: 500, x: 280 };
const FORMAT_LABEL = { image: '사진', carousel: '캐러셀', reel: '릴스', story: '스토리', text: '글', video: '영상', thread: '스레드' };
const ERR = {
  not_ready: '아직 올릴 수 없어요', no_key: 'Claude 키가 없습니다(ANTHROPIC_API_KEY)', bad_transition: '지금 상태에선 할 수 없어요', locked: '올라갔거나 올리는 중이라 못 고쳐요',
  text_required: '글감을 적어 주세요', no_accounts: '줄을 하나 이상 골라 주세요', ai_empty: 'Claude 답이 비었어요 — 다시', no_app: 'Meta 앱 설정이 없습니다', no_secret: 'SESSION_SECRET 이 없어 연결을 받지 않아요',
  not_yet: 'X 연결은 2차에 열려요', has_posted: '올라간 게시물이 있는 줄은 지울 수 없어요', no_ig_token: 'Instagram 을 먼저 한 번 로그인해 주세요', not_assigned: '이 토큰에 배정된 계정이 아니에요',
  too_large: '25MB 를 넘어요', unsupported: 'JPG·PNG 사진, MP4 영상만', no_media: '미디어 저장소(KV)가 없습니다', bad_slot: '시간은 HH:MM', server_error: '서버 오류 — 잠시 뒤 다시',
};
const say = (e) => (e && e.body && Array.isArray(e.body.detail) ? e.body.detail.join(' · ') : ERR[e && e.message] || (e && e.body && e.body.hint) || (e && e.message) || '오류');
const fail = (e) => toast(say(e), true);

// ---------- 시작 ----------
boot();
async function boot() {
  if (!authed()) return showLock();
  showApp();
  await load();
  oauthReturn();
  setInterval(() => { if (document.visibilityState === 'visible' && !S.importing) load({ quiet: true }); }, 60000);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (S.sheet) closeSheet(); else select(''); } });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderMap, 150); });
}
function showLock() {
  $('lock').hidden = false;
  $('lockForm').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button'); busy(b, true); $('lockMsg').textContent = '';
    try { await api.login($('lockPw').value); location.reload(); }
    catch (err) { busy(b, false); $('lockMsg').textContent = err.status === 401 ? '' : say(err); $('lock').classList.remove('shake'); void $('lock').offsetWidth; $('lock').classList.add('shake'); $('lockPw').select(); }
  };
  setTimeout(() => $('lockPw').focus(), 50);
}
function showApp() {
  $('top').hidden = false; $('map').hidden = false; $('fab').hidden = false;
  $('fab').onclick = () => openSheet({ kind: 'make' });
  $('scrim').onclick = closeSheet;
}
function oauthReturn() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('linked')) { toast(`${PLAT_NAME[h.get('linked')] || ''} 연결됨`); openSheet({ kind: 'lines' }); }
  else if (h.get('oauth')) { toast({ denied: '연결을 취소했어요', failed: '연결 실패 — 채널 기록을 보세요', bad_state: '연결 시간이 지났어요 — 다시' }[h.get('oauth')] || '연결 실패', true); openSheet({ kind: 'lines' }); }
  if (location.hash) history.replaceState(null, '', location.pathname);
}

async function load({ quiet = false } = {}) {
  const from = weekStart(Date.now()) + S.week * 7 * DAY;
  try {
    const d = await api.state(from, from + 7 * DAY);
    S.prev = new Map((S.data ? S.data.posts : []).map((p) => [p.id, p.state]));
    S.data = d;
    if (S.sheet && S.sheet.kind === 'post') { const fresh = d.posts.find((p) => p.id === S.sheet.id); if (fresh) S.sheet.post = fresh; }
    renderTop(); renderMap();
    if (S.sheet && !quiet) renderSheet();
    else if (S.sheet && quiet && S.sheet.kind === 'post') { const p = postById(S.sheet.id); if (p && ['publishing'].includes(p.state)) renderSheet(); }
  } catch (e) { if (!quiet) fail(e); }
}
const postById = (id) => (S.data && S.data.posts.find((p) => p.id === id)) || (S.sheet && S.sheet.post && S.sheet.post.id === id ? S.sheet.post : null);
const accountById = (id) => S.data.accounts.find((a) => a.id === id);
function upsertPost(post) {
  const i = S.data.posts.findIndex((p) => p.id === post.id);
  S.prev = new Map(S.data.posts.map((p) => [p.id, p.state]));
  if (i >= 0) S.data.posts[i] = post; else if (post.scheduled_at >= S.data.from && post.scheduled_at < S.data.to) S.data.posts.push(post);
  if (S.sheet && S.sheet.post && S.sheet.post.id === post.id) S.sheet.post = post;
}

// ---------- 머리 ----------
function renderTop() {
  const d = S.data; const top = $('top'); top.innerHTML = '';
  const from = d.from;
  const wait = el('button', { class: 'count wait', type: 'button', title: '내 차례(승인 대기)', hidden: !d.waiting.review, onclick: () => jumpTo(d.waiting.next, 'review') }, String(d.waiting.review));
  const failed = el('button', { class: 'count fail', type: 'button', title: '실패', hidden: !d.waiting.failed, onclick: () => { const f = d.posts.find((p) => p.state === 'failed'); if (f) { select(f.id); openSheet({ kind: 'post', id: f.id }); } else toast('이번 주엔 실패한 역이 없어요 — 다른 주를 보세요'); } }, String(d.waiting.failed));
  const week = el('div', { class: 'week' },
    el('button', { class: 'iconb', type: 'button', 'aria-label': '지난주', onclick: () => { S.week--; select(''); load(); } }, icon('left')),
    el('b', {}, `${md(from)} – ${md(from + 6 * DAY)}`),
    el('button', { class: 'iconb', type: 'button', 'aria-label': '다음 주', onclick: () => { S.week++; select(''); load(); } }, icon('right')),
    S.week ? el('button', { class: 'today', type: 'button', onclick: () => { S.week = 0; select(''); load(); } }, '오늘') : null);
  const tool = (k, label, fn, cls = '') => el('button', { class: 'iconb ' + cls + (S.sheet && S.sheet.kind === k ? ' on' : ''), type: 'button', 'aria-label': label, title: label, onclick: fn }, icon({ lib: 'lib', lines: 'lines', brand: 'brand', theme: 'moon', out: 'out' }[k]));
  top.append(
    el('span', { html: WORDMARK }), wait, failed, week,
    el('div', { class: 'tools' },
      tool('lib', '보관함', () => toggleSheet('lib')), tool('lines', '채널', () => toggleSheet('lines')), tool('brand', '브랜드 시트', () => toggleSheet('brand')),
      tool('theme', '테마', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('rene.theme', t); } catch { /* 무시 */ } renderMap(); }, 'opt'),
      tool('out', '나가기', () => { clearAuth(); location.reload(); }, 'opt')));
}
async function jumpTo(ms, state) {
  if (!ms) return;
  S.week = Math.round((weekStart(ms) - weekStart(Date.now())) / (7 * DAY));
  await load();
  const p = S.data.posts.filter((x) => x.state === state).sort((a, b) => a.scheduled_at - b.scheduled_at)[0];
  if (p) { select(p.id); openSheet({ kind: 'post', id: p.id }); }
}

// ---------- 노선도 ----------
function renderMap() {
  if (!S.data) return;
  const root = $('map'); const prevScroll = root.scrollLeft; root.innerHTML = '';
  const d = S.data;
  const colors = lineColors(d.accounts);
  const m = drawMap(root, { accounts: d.accounts, posts: d.posts, from: d.from, now: Date.now(), colors, selected: S.sel, prev: S.prev }, {
    station: (id) => { select(id === S.sel ? '' : id); },
    term: (id) => { S.focusLine = id; openSheet({ kind: 'lines' }); },
    blank: () => select(''),
  });
  const keep = root.dataset.week === String(S.week) ? prevScroll : null;
  root.append(el('div', { class: 'track' }, m.svg, m.terms));
  S.pos = m.pos;
  // 좁은 화면 — 처음엔 「지금」이 보이게, 그 뒤로는 보던 자리 그대로
  if (keep != null) root.scrollLeft = keep;
  else if (!S.week && root.clientWidth < m.width) root.scrollLeft = Math.max(0, m.nowX - 140);
  root.dataset.week = String(S.week);
  if (!d.posts.length && !S.week) root.append(el('div', { class: 'hint' }, '＋ 로 글감을 넣거나, ', icon('lib'), ' 에 폴더를 놓으세요'));
  if (S.sel) popover();
  S.prev = new Map(d.posts.map((p) => [p.id, p.state]));
}
function select(id) {
  S.sel = id;
  document.querySelectorAll('.map .st').forEach((g) => g.classList.toggle('sel', g.dataset.id === id));
  popover();
}
function popover() {
  document.querySelectorAll('.popo').forEach((x) => x.remove());
  const p = S.sel && postById(S.sel); const at = S.pos && S.pos.get(S.sel);
  if (!p || !at) return;
  const acc = accountById(p.account_id);
  const thumb = el('div', { class: 'th' }, mediaThumb(p) || FORMAT_LABEL[p.format]);
  const acts = el('div', { class: 'acts' });
  if (p.state === 'review') {
    const ok = el('button', { class: 'btn ink sm', type: 'button', disabled: p.problems.length > 0, onclick: async (e) => { busy(e.currentTarget, true); try { upsertPost((await api.act(p.id, 'approve')).post); toast('예약했어요'); renderMap(); renderTop(); } catch (er) { fail(er); busy(e.currentTarget, false); } } }, el('span', {}, '승인'));
    acts.append(ok);
  }
  acts.append(el('button', { class: 'btn ghost sm', type: 'button', onclick: () => openSheet({ kind: 'post', id: p.id }) }, '열기'));
  const box = el('div', { class: 'popo', role: 'dialog' }, thumb,
    el('b', {}, p.title || p.caption.split('\n')[0] || FORMAT_LABEL[p.format]),
    el('span', { class: 'mono muted' }, `${DOW[kst(p.scheduled_at).dow]} ${hm(p.scheduled_at)} · ${FORMAT_LABEL[p.format]}${p.media.length > 1 ? ' ' + p.media.length + '장' : ''}`),
    p.state === 'review' && p.problems.length ? el('span', { class: 'why' }, p.problems[0]) : p.state !== 'review' ? el('span', { class: 'why' }, `${STATE_LABEL[p.state]} · ${acc ? lineLabel(acc) : ''}`) : null,
    acts);
  const root = $('map');
  const left = Math.max(8, Math.min(at.x - 30, root.scrollWidth - 262));
  const below = at.y + 22;
  box.style.left = left + 'px'; box.style.top = below + 'px';
  root.append(box);
}
function mediaThumb(p) {
  const m = p.media.find((x) => x.url); if (!m) return null;
  if (m.kind === 'video') { const cover = p.cover && S.data.assets.find((a) => a.id === p.cover); return cover ? el('img', { src: cover.url, alt: '' }) : el('video', { src: m.url, muted: true, preload: 'metadata' }); }
  return el('img', { src: m.url, alt: '', loading: 'lazy' });
}

// ---------- 시트 ----------
function toggleSheet(kind) { if (S.sheet && S.sheet.kind === kind) closeSheet(); else openSheet({ kind }); }
function openSheet(s) {
  const was = !!S.sheet;
  S.sheet = { ...s };
  if (!was) setTimeout(renderMap, 380); // 넓은 화면 — 노선도 폭이 시트만큼 줄어든다
  if (s.kind === 'post') S.sheet.post = postById(s.id);
  document.body.classList.add('sheet-open');
  renderSheet(); renderTop();
  if (s.kind === 'post' && !S.sheet.post) api.post(s.id).then((r) => { S.sheet.post = r.post; renderSheet(); }).catch(fail);
}
function closeSheet() { S.sheet = null; S.focusLine = ''; document.body.classList.remove('sheet-open'); $('sheet').innerHTML = ''; renderTop(); setTimeout(renderMap, 380); }
function frame(title, body, foot, extraHead) {
  const sh = $('sheet'); sh.innerHTML = '';
  sh.append(el('div', { class: 'grab' }), el('div', { class: 'head' }, extraHead || null, el('h2', {}, title), el('button', { class: 'iconb', type: 'button', 'aria-label': '닫기', onclick: closeSheet }, icon('x'))), body);
  if (foot) sh.append(foot);
}
function renderSheet() {
  if (!S.sheet || !S.data) return;
  const k = S.sheet.kind;
  if (k === 'make') return sheetMake();
  if (k === 'post') return sheetPost();
  if (k === 'lib') return sheetLib();
  if (k === 'lines') return sheetLines();
  if (k === 'brand') return sheetBrand();
}

// ---------- 만들기 ----------
function sheetMake() {
  const d = S.data; const st = S.sheet;
  if (!st.accounts) { // 연결된 줄 — 없으면 한국어 줄들(초안만 선다)
    const linked = d.accounts.filter((a) => a.status === 'linked');
    st.accounts = (linked.length ? linked : d.accounts.filter((a) => a.lang === 'ko' && a.platform !== 'x')).map((a) => a.id);
  }
  st.assets ||= [];
  const colors = lineColors(d.accounts);
  const ta = el('textarea', { id: 'makeText', class: 'big', placeholder: '무엇을 알릴까? — 장면 하나, 강조할 점 하나', oninput: (e) => { st.text = e.target.value; } });
  ta.value = st.text || '';
  const chips = el('div', { class: 'row' }, d.accounts.map((a) => el('button', {
    class: 'chip' + (st.accounts.includes(a.id) ? ' on' : '') + (a.status !== 'linked' ? ' off' : ''), type: 'button', style: `--c:${colors[a.id]}`, 'aria-pressed': st.accounts.includes(a.id) ? 'true' : 'false', title: a.status !== 'linked' ? '연결 전 줄 — 초안만 서요' : '',
    onclick: () => { st.accounts = st.accounts.includes(a.id) ? st.accounts.filter((x) => x !== a.id) : [...st.accounts, a.id]; sheetMake(); },
  }, el('i'), lineLabel(a))));
  const picked = el('div', { class: 'strip' }, st.assets.map((id) => { const a = d.assets.find((x) => x.id === id); return a ? el('div', { class: 'tile' }, assetEl(a), el('div', { class: 'ctl' }, el('span'), el('button', { type: 'button', 'aria-label': '빼기', onclick: () => { st.assets = st.assets.filter((x) => x !== id); sheetMake(); } }, '×'))) : null; }),
    el('button', { class: 'tile add', type: 'button', 'aria-label': '소재 고르기', onclick: () => { st.picking = !st.picking; sheetMake(); } }, st.picking ? '−' : '+'));
  const pickGrid = st.picking ? el('div', { class: 'lib' }, d.assets.filter((a) => a.src !== 'card').slice(0, 60).map((a) => el('button', { class: 'tile' + (st.assets.includes(a.id) ? ' sel' : ''), type: 'button', onclick: () => { st.assets = st.assets.includes(a.id) ? st.assets.filter((x) => x !== a.id) : [...st.assets, a.id].slice(0, 8); sheetMake(); } }, assetEl(a)))) : null;
  const go = el('button', { class: 'btn ink full', type: 'button', disabled: !d.caps.ai, onclick: (e) => make(e.currentTarget) }, el('span', { class: 'led' }), el('span', {}, d.caps.ai ? '만들기' : 'Claude 키 없음'));
  const fan = st.running ? fanEl(st.accounts.map((id) => ({ c: colors[id], label: lineLabel(accountById(id)) }))) : null;
  frame('만들기', el('div', { class: 'body' }, ta, picked, pickGrid, chips, fan || null), el('div', { class: 'foot' }, go));
  if (!st.running) setTimeout(() => { const t = $('makeText'); if (t && document.activeElement !== t) t.focus(); }, 60);
  if (st.running) busy(go, true);
}
function fanEl(lines) {
  const n = Math.max(lines.length, 1); const h = Math.max(70, n * 30 + 10);
  const svg = el('svg:svg', { viewBox: `0 0 320 ${h}` });
  svg.append(el('svg:circle', { cx: 18, cy: h / 2, r: 9, style: 'fill:var(--sheet);stroke:var(--ink);stroke-width:4' }));
  lines.forEach((l, i) => {
    const y = n === 1 ? h / 2 : 15 + i * ((h - 30) / (n - 1));
    svg.append(el('svg:path', { class: 'ln', d: `M27 ${h / 2}C90 ${h / 2} 100 ${y} 170 ${y}`, style: `stroke:${l.c};animation-delay:${i * 0.15}s` }), el('svg:text', { x: 184, y: y + 4 }, l.label));
  });
  return el('div', { class: 'fan' }, svg, el('p', { class: 'muted', style: 'margin:4px 0 0;font-size:13px' }, 'Claude가 계정마다 쓰고, 카드를 찍는 중…'));
}
async function make(btn) {
  const st = S.sheet;
  if (!String(st.text || '').trim()) { toast('글감을 적어 주세요', true); return; }
  if (!st.accounts.length) { toast('줄을 하나 이상 골라 주세요', true); return; }
  st.running = true; sheetMake();
  try {
    const r = await api.make({ text: st.text, accounts: st.accounts, assets: st.assets });
    S.sheet = null; document.body.classList.remove('sheet-open'); $('sheet').innerHTML = '';
    const first = (await api.post(r.posts[0])).post;
    S.week = Math.round((weekStart(first.scheduled_at) - weekStart(Date.now())) / (7 * DAY));
    await load();
    select(first.id);
    toast(`${r.posts.length}개 역이 섰어요 — 내 차례`);
  } catch (e) { st.running = false; sheetMake(); fail(e); }
}

// ---------- 역(게시물) ----------
function sheetPost() {
  const p = S.sheet.post;
  if (!p) return frame('…', el('div', { class: 'body' }));
  const acc = accountById(p.account_id) || { platform: 'ig', lang: 'ko', username: '' };
  const colors = lineColors(S.data.accounts); const c = colors[p.account_id] || 'var(--ink)';
  const lockd = ['posted', 'publishing'].includes(p.state);
  const body = el('div', { class: 'body' });

  // 형식
  const formats = Object.keys(S.data.formats[acc.platform] || {});
  body.append(el('div', { class: 'row' }, el('span', { class: 'pill' + (acc.status === 'linked' ? '' : ' dash'), style: `--c:${c}` }, lineLabel(acc)),
    ...formats.map((f) => el('button', { class: 'chip' + (p.format === f ? ' on' : ''), type: 'button', style: `--c:${c}`, disabled: lockd, onclick: () => patch({ format: f }) }, FORMAT_LABEL[f])),
    el('span', { class: 'chip' + (p.state === 'failed' ? ' bad' : p.state === 'review' ? ' warn' : '') }, STATE_LABEL[p.state])));
  if (p.error) body.append(el('div', { class: 'note' + (p.state === 'failed' ? ' bad' : '') }, p.error));
  if (p.warn) body.append(el('div', { class: 'note' }, p.warn));
  if (p.state === 'review' && p.problems.length) body.append(el('div', { class: 'row' }, p.problems.map((x) => el('span', { class: 'chip warn' }, x))));

  // 미리보기
  body.append(preview(p, acc, c));

  // 장
  if (S.data.formats[acc.platform][p.format] && S.data.formats[acc.platform][p.format].max > 0) {
    const strip = el('div', { class: 'strip' });
    p.media.forEach((m, i) => {
      const t = el('div', { class: 'tile' }, m.url ? (m.kind === 'video' ? el('video', { src: m.url, muted: true, preload: 'metadata' }) : el('img', { src: m.url, alt: '' })) : el('div', { class: 'no' }, '카드 대기'), el('span', { class: 'num' }, String(i + 1)));
      if (!lockd) t.append(el('div', { class: 'ctl' },
        el('button', { type: 'button', 'aria-label': '앞으로', onclick: () => move(i, -1) }, '‹'),
        el('button', { type: 'button', 'aria-label': '빼기', onclick: () => patch({ media: p.media.filter((_, k) => k !== i).map((x) => x.asset).filter(Boolean) }) }, '×'),
        el('button', { type: 'button', 'aria-label': '뒤로', onclick: () => move(i, 1) }, '›')));
      strip.append(t);
    });
    if (!lockd) strip.append(el('button', { class: 'tile add', type: 'button', 'aria-label': '장 더하기', onclick: () => { S.sheet.picking = !S.sheet.picking; sheetPost(); } }, S.sheet.picking ? '−' : '+'));
    body.append(el('div', { class: 'field' }, el('span', { class: 'lbl' }, '장', p.media.some((m) => m.card && !m.url) ? el('button', { class: 'btn sm', type: 'button', onclick: async (e) => { busy(e.currentTarget, true); try { upsertPost((await api.render(p.id)).post); sheetPost(); renderMap(); } catch (er) { fail(er); busy(e.currentTarget, false); } } }, el('span', {}, '다시 찍기')) : null), strip));
    if (S.sheet.picking) body.append(el('div', { class: 'lib' }, S.data.assets.slice(0, 80).map((a) => el('button', { class: 'tile', type: 'button', onclick: () => { S.sheet.picking = false; patch({ media: [...p.media.map((x) => x.asset).filter(Boolean), a.id] }); } }, assetEl(a)))));
    if (p.format === 'reel') {
      body.append(el('div', { class: 'field' }, el('span', { class: 'lbl' }, '커버'), el('div', { class: 'strip' },
        S.data.assets.filter((a) => a.kind === 'image' && a.src !== 'card').slice(0, 30).map((a) => el('button', { class: 'tile' + (p.cover === a.id ? ' sel' : ''), type: 'button', disabled: lockd, onclick: () => patch({ cover: p.cover === a.id ? '' : a.id }) }, assetEl(a))))),
      el('label', { class: 'row', style: 'font-size:14px' }, el('input', { type: 'checkbox', checked: !!p.trial, disabled: lockd, onchange: (e) => patch({ trial: e.target.checked }) }), '시험 릴스 — 팔로워가 아닌 사람에게 먼저'));
    }
  }

  // 글
  const lim = LIMIT[acc.platform] || 2200;
  const cnt = el('span', { class: 'mono' });
  const capField = el('textarea', { rows: 6, disabled: lockd, onchange: (e) => patch({ caption: e.target.value }), oninput: (e) => count(e.target.value) });
  capField.value = p.caption;
  const count = (v) => { const n = v.length + (acc.platform === 'ig' && p.hashtags ? p.hashtags.split(' ').join(' #').length + 3 : 0); cnt.textContent = `${n}/${lim}`; cnt.classList.toggle('over', n > lim); };
  count(p.caption);
  body.append(el('div', { class: 'field' }, el('span', { class: 'lbl' }, '글', cnt), capField));
  if (acc.platform === 'ig') {
    const tags = el('input', { type: 'text', value: p.hashtags ? '#' + p.hashtags.split(' ').join(' #') : '', placeholder: '#르네 #AI펫', disabled: lockd, onchange: (e) => patch({ hashtags: e.target.value }) });
    body.append(el('div', { class: 'field' }, el('span', { class: 'lbl' }, '해시태그'), tags));
  }
  if (p.format !== 'story') {
    const fr = el('textarea', { rows: 2, placeholder: acc.platform === 'th' ? '첫 댓글 — 행동 하나(링크 가능)' : '첫 댓글', disabled: lockd, onchange: (e) => patch({ first_reply: e.target.value }) });
    fr.value = p.first_reply;
    body.append(el('div', { class: 'field' }, el('span', { class: 'lbl' }, '첫 댓글'), fr));
  }
  // 시간
  const when = el('input', { type: 'datetime-local', value: toLocalInput(p.scheduled_at), disabled: lockd, onchange: (e) => { const t = fromLocalInput(e.target.value); if (t) patch({ scheduled_at: t }); } });
  body.append(el('div', { class: 'field' }, el('span', { class: 'lbl' }, '시간', el('span', { class: 'mono' }, '한국 시간')), when));

  // 한 마디로 고치기
  if (!lockd) {
    const inp = el('input', { type: 'text', placeholder: '한 마디로 고치기 — 예: 첫 줄을 질문으로', onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) revise(e.target.value.trim(), go); } });
    const go = el('button', { class: 'btn', type: 'button', disabled: !S.data.caps.ai, onclick: () => inp.value.trim() && revise(inp.value.trim(), go) }, el('span', { class: 'led' }), el('span', {}, '고치기'));
    body.append(el('div', { class: 'field' }, el('div', { class: 'say' }, inp, go),
      el('div', { class: 'row' }, ['더 짧게', '첫 줄 더 세게', '질문으로 시작', '사진 위주로', '카드 한 장 더'].map((s) => el('button', { class: 'chip', type: 'button', disabled: !S.data.caps.ai, onclick: () => revise(s, go) }, s)))));
  }
  if (p.state === 'posted') {
    const m = p.metrics || {};
    body.append(el('div', { class: 'metrics' }, ...[['좋아요', m.likes], ['댓글', m.comments], ['도달', m.reach], ['조회', m.views], ['저장', m.saved]].filter(([, v]) => v != null).map(([k, v]) => el('span', {}, el('b', {}, String(v)), k)), p.published_at ? el('span', {}, ago(p.published_at)) : null));
  }

  // 아래 단추
  const foot = el('div', { class: 'foot' });
  const act = (label, action, cls = '') => el('button', { class: 'btn ' + cls, type: 'button', disabled: action === 'approve' && p.problems.length > 0, onclick: (e) => doAct(action, e.currentTarget) }, el('span', {}, label));
  const now = el('button', { class: 'btn', type: 'button', disabled: p.state === 'review' && p.problems.length > 0, onclick: (e) => publishNow(e.currentTarget) }, el('span', {}, '지금 올리기'));
  const del = el('button', { class: 'btn ghost danger', type: 'button', onclick: (e) => twoTap(e.currentTarget, '한 번 더', async () => { await api.delPost(p.id); S.data.posts = S.data.posts.filter((x) => x.id !== p.id); closeSheet(); load({ quiet: true }); toast('지웠어요'); }) }, el('span', {}, '지우기'));
  if (p.state === 'review') foot.append(act('승인', 'approve', 'ink'), now, el('span', { class: 'grow' }), act('건너뛰기', 'skip', 'ghost'), del);
  else if (p.state === 'scheduled') foot.append(now, act('보류', 'hold'), el('span', { class: 'grow' }), act('건너뛰기', 'skip', 'ghost'));
  else if (p.state === 'failed') foot.append(act('다시', 'retry', 'ink'), act('보류', 'hold'), el('span', { class: 'grow' }), act('건너뛰기', 'skip', 'ghost'));
  else if (p.state === 'skipped') foot.append(act('되살리기', 'restore'), el('span', { class: 'grow' }), del);
  else if (p.state === 'publishing') foot.append(el('span', { class: 'muted', style: 'font-size:14px;display:flex;gap:8px;align-items:center' }, el('span', { class: 'led' }), '올리는 중 — 영상은 몇 분 걸려요'));
  else if (p.state === 'posted' && p.permalink) foot.append(el('a', { class: 'btn ink', href: p.permalink, target: '_blank', rel: 'noopener' }, '게시물 보기', icon('link')));
  frame(p.title || FORMAT_LABEL[p.format], body, foot);
}
function move(i, dir) {
  const ids = S.sheet.post.media.map((x) => x.asset);
  const j = i + dir; if (j < 0 || j >= ids.length || ids.some((x) => !x)) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  patch({ media: ids });
}
async function patch(body) {
  const p = S.sheet && S.sheet.post; if (!p) return;
  try { upsertPost((await api.patch(p.id, body)).post); renderMap(); if (!('caption' in body || 'first_reply' in body || 'hashtags' in body)) sheetPost(); else refreshProblems(); }
  catch (e) { fail(e); }
}
function refreshProblems() { // 글만 바뀌면 시트를 다시 그리지 않는다(입력 중 커서 보존) — 문제 칩만 새로
  const p = S.sheet.post; const box = document.querySelector('#sheet .body');
  if (!box) return;
  const ok = document.querySelector('#sheet .foot .btn.ink');
  if (ok && p.state === 'review') ok.disabled = p.problems.length > 0;
}
async function doAct(action, btn) {
  busy(btn, true);
  try { upsertPost((await api.act(S.sheet.post.id, action)).post); toast({ approve: '예약했어요', hold: '내 차례로 돌렸어요', skip: '건너뛰었어요', retry: '다시 예약했어요', restore: '되살렸어요' }[action]); renderMap(); renderTop(); sheetPost(); load({ quiet: true }); }
  catch (e) { busy(btn, false); fail(e); }
}
async function publishNow(btn) {
  busy(btn, true);
  try { const r = await api.now(S.sheet.post.id); upsertPost(r.post); toast(r.post.state === 'posted' ? '올라갔어요' : r.post.state === 'failed' ? '실패 — 이유를 보세요' : '올리는 중 — 크론이 이어 가요', r.post.state === 'failed'); renderMap(); renderTop(); sheetPost(); load({ quiet: true }); }
  catch (e) { busy(btn, false); fail(e); }
}
async function revise(text, btn) {
  busy(btn, true);
  try { upsertPost((await api.revise(S.sheet.post.id, text)).post); toast('고쳤어요'); renderMap(); sheetPost(); }
  catch (e) { busy(btn, false); fail(e); }
}
function twoTap(btn, label, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; fn().catch(fail); return; }
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = old; } }, 2500);
}

// 플랫폼 미리보기
function preview(p, acc, c) {
  const items = p.media.map((m) => (m.url ? (m.kind === 'video' ? el('video', { src: m.url, controls: true, playsinline: true, preload: 'metadata', poster: coverUrl(p) }) : el('img', { src: m.url, alt: '' })) : el('div', { class: 'ph' }, '카드 대기')));
  const av = el('span', { class: 'av' }, acc.picture ? el('img', { src: acc.picture, alt: '' }) : el('span', { html: WORDMARK }));
  const name = acc.username || (acc.status === 'linked' ? acc.name : '연결 전');
  const capText = (txt, tags) => el('div', { class: 'cap clamp' }, txt, tags ? el('span', { class: 'tags' }, '\n\n#' + tags.split(' ').join(' #')) : null);
  if (acc.platform === 'ig') {
    const tall = p.format === 'reel' || p.format === 'story';
    const slides = el('div', { class: 'slides' + (tall ? ' tall' : '') }, items.length ? items : el('div', { class: 'ph' }, '사진·영상을 넣어 주세요'));
    const dots = items.length > 1 ? el('div', { class: 'dots', style: `--c:${c}` }, items.map((_, i) => el('i', { class: i ? '' : 'on' }))) : null;
    if (dots) slides.addEventListener('scroll', () => { const i = Math.round(slides.scrollLeft / slides.clientWidth); [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i)); }, { passive: true });
    return el('div', { class: 'phone' }, el('div', { class: 'who' }, av, name, el('small', {}, FORMAT_LABEL[p.format])), slides, dots, p.format === 'story' ? null : capText(p.caption, p.hashtags),
      p.first_reply ? el('div', { class: 'cap muted', style: 'font-size:12px' }, el('b', {}, name + ' '), p.first_reply) : null);
  }
  const post = el('div', { class: 'thr' }, el('div', { class: 'rail' }, av), el('div', {}, el('div', { class: 'who' }, name, el('small', {}, PLAT_NAME[acc.platform])), el('div', { class: 'cap' }, p.caption), items.length ? el('div', { class: 'imgs' }, items) : null));
  const reply = p.first_reply ? el('div', { class: 'thr', style: 'margin-top:6px' }, el('div', { class: 'rail' }, el('span', { class: 'av' }, acc.picture ? el('img', { src: acc.picture, alt: '' }) : el('span', { html: WORDMARK }))), el('div', {}, el('div', { class: 'who' }, name), el('div', { class: 'cap' }, p.first_reply))) : null;
  return el('div', { class: 'phone' }, post, reply);
}
const coverUrl = (p) => { const a = p.cover && S.data.assets.find((x) => x.id === p.cover); return a ? a.url : ''; };
function assetEl(a) {
  return a.kind === 'video' ? el('video', { src: a.url, muted: true, preload: 'metadata' }) : el('img', { src: a.url, alt: a.title || '', loading: 'lazy' });
}

// ---------- 보관함 · 가져오기 ----------
function sheetLib() {
  const d = S.data; const imp = S.importing;
  const fileIn = el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,video/mp4,video/quicktime,.txt,.md', hidden: true, onchange: (e) => takeFiles([...e.target.files].map((f) => ({ file: f, path: f.name }))) });
  const dirIn = el('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true, onchange: (e) => takeFiles([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))) });
  const drop = el('div', { class: 'drop' },
    el('div', { class: 'row' }, el('svg:svg', { viewBox: '0 0 36 36', html: '<path d="M4 9a3 3 0 0 1 3-3h7l3 4h12a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M18 15v9M14 19l4-4 4 4"/>' }),
      el('span', { style: 'flex:1;font-size:14px;font-weight:600' }, imp ? imp.label : '폴더나 파일을 놓기'),
      el('span', { class: 'row' }, el('button', { class: 'btn sm', type: 'button', disabled: !!imp, onclick: () => dirIn.click() }, '폴더'), el('button', { class: 'btn sm', type: 'button', disabled: !!imp, onclick: () => fileIn.click() }, '파일'))),
    imp ? el('div', {}, el('div', { class: 'bar-p' }, el('i', { style: `width:${Math.round((imp.done / Math.max(imp.total, 1)) * 100)}%` })), el('div', { class: 'mono muted', style: 'font-size:12px;margin-top:6px' }, `${imp.done}/${imp.total} · ${imp.now || ''}`)) : null,
    fileIn, dirIn);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); if (!S.importing) takeFiles(await dropped(e.dataTransfer)); });
  const used = new Map();
  const colors = lineColors(d.accounts);
  for (const p of d.posts) for (const m of p.media) if (m.asset) used.set(m.asset, colors[p.account_id]);
  const grid = el('div', { class: 'lib' }, d.assets.map((a) => {
    const t = el('div', { class: 'tile', style: used.has(a.id) ? `--c:${used.get(a.id)};--f:${used.get(a.id)}` : '' }, assetEl(a), used.has(a.id) ? el('span', { class: 'dot' }) : null,
      el('div', { class: 'ctl' }, el('span', { class: 'num', style: 'position:static' }, a.kind === 'video' ? '영상' : a.src === 'card' ? '카드' : ''), el('button', { type: 'button', 'aria-label': '지우기', onclick: (e) => twoTap(e.currentTarget, '!', async () => { const r = await api.delAsset(a.id); d.assets = d.assets.filter((x) => x.id !== a.id); toast(r.detached ? `지웠어요 — 게시물 ${r.detached}개에서 빠짐` : '지웠어요'); sheetLib(); load({ quiet: true }); }) }, '×')));
    t.title = a.title || '';
    return t;
  }));
  frame('보관함', el('div', { class: 'body' }, drop, d.assets.length ? grid : el('p', { class: 'muted', style: 'margin:0;font-size:14px' }, '오늘 만든 「2026-11-04_르네_인스타_스레드」 폴더를 통째로 놓으면 게시물 묶음대로 들어와 「내 차례」로 섭니다.')));
}
async function dropped(dt) {
  const out = [];
  const walk = (entry, path) => new Promise((res) => {
    if (entry.isFile) entry.file((f) => { out.push({ file: f, path: path + f.name }); res(); }, () => res());
    else if (entry.isDirectory) {
      const r = entry.createReader(); const all = [];
      const more = () => r.readEntries(async (list) => { if (!list.length) { for (const e of all) await walk(e, path + entry.name + '/'); res(); } else { all.push(...list); more(); } }, () => res());
      more();
    } else res();
  });
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  for (const e of entries) await walk(e, '');
  return out;
}
const IMG = /\.(png|jpe?g|webp)$/i; const VID = /\.(mp4|mov|m4v)$/i;
async function takeFiles(list) {
  if (!list.length) return;
  const groups = groupFiles(list.map((x) => x.path));
  const byPath = new Map(list.map((x) => [x.path, x.file]));
  const d = S.data;
  const lineFor = (g) => d.accounts.filter((a) => a.platform === g.platform && a.lang === g.lang).sort((a, b) => (b.status === 'linked') - (a.status === 'linked'))[0];
  const useful = groups.filter(lineFor);
  const loose = groups.length ? [] : list.filter((x) => IMG.test(x.path) || VID.test(x.path)).map((x) => x.path);
  const need = [...new Set([...useful.flatMap((g) => [...g.media, g.cover].filter(Boolean)), ...loose])];
  S.importing = { total: need.length, done: 0, label: groups.length ? `게시물 ${useful.length}개 · 파일 ${need.length}개 올리는 중` : `파일 ${need.length}개 올리는 중` };
  if (S.sheet && S.sheet.kind === 'lib') sheetLib();
  const idOf = new Map(); let skippedFiles = 0;
  try {
    for (const path of need) {
      S.importing.now = path.split('/').slice(-2).join('/');
      if (S.sheet && S.sheet.kind === 'lib') sheetLib();
      try { idOf.set(path, (await uploadOne(byPath.get(path), path)).id); }
      catch (e) { skippedFiles++; console.warn('upload', path, e); }
      S.importing.done++;
    }
    let made = 0; let skipped = groups.length - useful.length;
    if (useful.length) {
      const text = async (p) => (p && byPath.get(p) ? (await byPath.get(p).text()).trim() : '');
      const items = [];
      for (const g of useful) {
        const media = g.media.map((m) => idOf.get(m)).filter(Boolean);
        if (g.media.length && media.length < g.media.length) { skipped++; continue; }
        items.push({ account_id: lineFor(g).id, format: g.format, title: g.title, caption: await text(g.caption), first_reply: await text(g.reply), media, cover: g.cover ? idOf.get(g.cover) || '' : '', src: g.format === 'story' ? g.media[0] : g.dir, pinned: g.pinned, group: g.format === 'story' ? '' : g.title });
      }
      for (let i = 0; i < items.length; i += 100) { const r = await api.importItems(items.slice(i, i + 100)); made += r.made; skipped += r.skipped; }
    }
    S.importing = null;
    toast(useful.length ? `게시물 ${made}개 들어옴${skipped ? ` · 건너뜀 ${skipped}` : ''}${skippedFiles ? ` · 못 올린 파일 ${skippedFiles}` : ''}` : `파일 ${need.length - skippedFiles}개 들어옴`);
    S.week = 0; await load();
  } catch (e) { S.importing = null; fail(e); if (S.sheet && S.sheet.kind === 'lib') sheetLib(); }
}
// 사진은 브라우저에서 JPEG 로(Instagram 은 JPEG 만) — 서버 CPU 를 쓰지 않는다
async function uploadOne(file, path) {
  if (VID.test(path)) {
    if (file.size > 25 * 1024 * 1024) throw new Error('too_large');
    return (await api.upload(file, { src: path, title: path.split('/').slice(-2).join('/') })).asset;
  }
  const bmp = await createImageBitmap(file);
  let { width: w, height: h } = bmp;
  let blob = file;
  if (!/jpe?g$/i.test(file.type.split('/')[1] || '') || w > 2160) {
    const k = Math.min(1, 2160 / w); w = Math.round(w * k); h = Math.round(h * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
  }
  bmp.close && bmp.close();
  return (await api.upload(blob, { src: path, title: path.split('/').slice(-2).join('/'), w, h })).asset;
}

// ---------- 채널(줄) ----------
function sheetLines() {
  const d = S.data; const colors = lineColors(d.accounts); const st = S.sheet;
  const body = el('div', { class: 'body' });
  if (!d.caps.secret) body.append(el('div', { class: 'note bad' }, 'SESSION_SECRET 이 없어 연결을 받지 않아요(Cloudflare 비밀)'));
  if (!d.caps.ig || !d.caps.th) body.append(el('div', { class: 'note' }, `Meta 앱 설정 없음: ${[!d.caps.ig && 'Instagram', !d.caps.th && 'Threads'].filter(Boolean).join(' · ')}`));
  if (!d.caps.render) body.append(el('div', { class: 'note' }, '카드 찍기(Browser Rendering)가 꺼져 있어요 — 사진 소재로 올리거나 켜 주세요'));
  const lines = el('div', { class: 'lines' });
  for (const a of d.accounts) {
    const c = colors[a.id];
    const acts = el('div', { class: 'acts' });
    const more = el('div', { class: 'more' });
    const linked = a.status === 'linked';
    if (a.platform === 'x') acts.append(el('span', { class: 'chip off' }, '2차'));
    else if (!linked && a.platform === 'ig') acts.append(el('button', { class: 'btn sm', type: 'button', onclick: (e) => loadIg(e.currentTarget, a.id) }, el('span', {}, '불러오기')), el('button', { class: 'btn sm ghost', type: 'button', onclick: (e) => connect(e.currentTarget, a.id) }, el('span', {}, '로그인')));
    else if (!linked) acts.append(el('button', { class: 'btn sm', type: 'button', onclick: (e) => connect(e.currentTarget, a.id) }, el('span', {}, '로그인')));
    else acts.append(el('button', { class: 'btn sm ghost', type: 'button', onclick: (e) => twoTap(e.currentTarget, '끊을까요?', async () => { await api.unlink(a.id); toast('끊었어요'); load(); }) }, '끊기'));
    if (st.open === a.id || S.focusLine === a.id) {
      const slot = el('input', { type: 'time', value: a.slot || { ig: '20:00', th: '12:30', x: '09:00' }[a.platform], onchange: async (e) => { try { await api.patchLine(a.id, { slot: e.target.value }); toast('기본 시간을 바꿨어요'); load({ quiet: true }); } catch (er) { fail(er); } } });
      more.append(el('span', { class: 'muted', style: 'font-size:13px' }, '기본 시간'), slot,
        el('span', { class: 'seg' }, ...['ko', 'en'].map((l) => el('button', { class: a.lang === l ? 'on' : '', type: 'button', onclick: async () => { try { await api.patchLine(a.id, { lang: l }); load(); } catch (er) { fail(er); } } }, l.toUpperCase()))),
        el('span', { class: 'grow', style: 'flex:1' }),
        el('button', { class: 'btn sm ghost danger', type: 'button', onclick: (e) => twoTap(e.currentTarget, '줄을 지울까요?', async () => { await api.delLine(a.id); toast('줄을 지웠어요'); st.open = ''; load(); }) }, '줄 지우기'));
      if (S.igList && S.igList.line === a.id) {
        more.append(el('div', { class: 'row', style: 'width:100%' }, S.igList.needLogin ? el('span', { class: 'muted' }, 'Instagram 을 한 번 로그인하면 포트폴리오의 계정들이 여기 떠요') : S.igList.accounts.length ? S.igList.accounts.map((x) => el('button', { class: 'chip' + (x.line ? ' off' : ''), type: 'button', disabled: !!x.line, onclick: async (e) => { busy(e.currentTarget, true); try { await api.attachIg(a.id, x.id); S.igList = null; toast(`@${x.username} 연결됨`); load(); } catch (er) { fail(er); busy(e.currentTarget, false); } } }, '@' + x.username)) : el('span', { class: 'muted' }, '배정된 계정이 없어요 — 비즈니스 포트폴리오에서 시스템 사용자에 배정')));
      }
    }
    const row = el('div', { class: 'line' + (S.focusLine === a.id ? ' focus' : '') },
      el('span', { class: 'pill' + (linked ? '' : a.status === 'expired' ? ' exp' : ' dash'), style: `--c:${c}` }, lineLabel(a)),
      el('button', { class: 'who', type: 'button', style: 'text-align:left', onclick: () => { st.open = st.open === a.id ? '' : a.id; S.focusLine = ''; sheetLines(); } },
        el('b', {}, a.username ? '@' + a.username : '연결 전'), el('small', {}, `${PLAT_NAME[a.platform]} · ${a.lang === 'en' ? '영어' : '한국어'} · ${a.status === 'expired' ? '만료 — 다시 연결' : linked ? '연결됨' : '점선'}`)),
      el('div', { class: 'acts' }, el('span', { class: 'stat ' + a.status }), acts));
    if (more.childNodes.length) row.append(more);
    lines.append(row);
  }
  body.append(lines);
  // 줄 더하기
  st.newP ||= 'ig'; st.newL ||= 'en';
  body.append(el('div', { class: 'row' }, el('span', { class: 'lbl' }, '줄 더하기'),
    el('span', { class: 'seg' }, ...['ig', 'th', 'x'].map((p) => el('button', { class: st.newP === p ? 'on' : '', type: 'button', onclick: () => { st.newP = p; sheetLines(); } }, PLAT_NAME[p]))),
    el('span', { class: 'seg' }, ...['ko', 'en'].map((l) => el('button', { class: st.newL === l ? 'on' : '', type: 'button', onclick: () => { st.newL = l; sheetLines(); } }, l.toUpperCase()))),
    el('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api.addLine({ platform: st.newP, lang: st.newL }); toast('점선 줄을 세웠어요'); load(); } catch (e) { fail(e); } } }, '＋')));
  // 기록
  const log = el('details', { ontoggle: async (e) => { if (e.target.open && !S.events) { try { S.events = (await api.events()).events; sheetLines(); } catch (er) { fail(er); } } }, open: !!S.events },
    el('summary', {}, '최근 기록'),
    S.events ? el('div', { class: 'log' }, S.events.slice(0, 30).map((ev) => el('div', { class: ev.level }, el('span', { class: 'mono' }, ago(ev.at)), el('span', {}, `${ev.kind} · ${ev.detail}`)))) : null);
  body.append(log);
  frame('채널', body);
  if (S.focusLine) setTimeout(() => { const f = document.querySelector('.line.focus'); if (f) f.scrollIntoView({ block: 'nearest' }); }, 50);
}
async function loadIg(btn, lineId) {
  busy(btn, true);
  try { const r = await api.igAvailable(); S.igList = { ...r, line: lineId }; S.sheet.open = lineId; sheetLines(); }
  catch (e) { fail(e); busy(btn, false); }
}
async function connect(btn, id) {
  busy(btn, true);
  try { const r = await api.connect(id); location.href = r.url; }
  catch (e) { fail(e); busy(btn, false); }
}

// ---------- 브랜드 시트 ----------
function sheetBrand() {
  const b = S.data.brand;
  const t = (id, label, value, rows = 0, ph = '') => {
    const f = rows ? el('textarea', { id, rows, placeholder: ph }) : el('input', { id, type: 'text', placeholder: ph });
    f.value = value;
    return el('div', { class: 'field' }, el('label', { class: 'lbl', for: id }, label), f);
  };
  const body = el('div', { class: 'body' },
    el('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'Claude는 여기 적힌 사실만 씁니다. 줄 하나에 하나.'),
    t('bOne', '한 줄', b.oneliner), t('bFacts', '사실', b.facts.join('\n'), 9), t('bBan', '쓰지 않는 말', b.banned.join('\n'), 4), t('bTone', '말투', b.tone, 3),
    el('div', { class: 'row nowrap' }, t('bKwKo', '댓글 키워드 KO', b.kw.ko), t('bKwEn', 'EN', b.kw.en)),
    t('bLink', '링크(프로필)', b.link),
    t('bTagKo', '해시태그 KO', b.tags.ko.map((x) => '#' + x).join(' ')), t('bTagEn', '해시태그 EN', b.tags.en.map((x) => '#' + x).join(' ')));
  const save = el('button', { class: 'btn ink', type: 'button', onclick: async (e) => {
    busy(e.currentTarget, true);
    const v = (id) => $(id).value;
    try { S.data.brand = (await api.saveBrand({ name: b.name, oneliner: v('bOne'), facts: v('bFacts'), banned: v('bBan'), tone: v('bTone'), kw: { ko: v('bKwKo'), en: v('bKwEn') }, link: v('bLink'), tags: { ko: v('bTagKo'), en: v('bTagEn') } })).brand; toast('저장했어요'); sheetBrand(); }
    catch (er) { fail(er); busy(e.currentTarget, false); }
  } }, el('span', {}, '저장'));
  frame('브랜드 시트', body, el('div', { class: 'foot' }, save));
}

// 로컬 시험용 — localhost 에서만 가져오기 함수를 연다(브라우저 자동화는 폴더 고르기를 못 한다)
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__rene = { takeFiles };
