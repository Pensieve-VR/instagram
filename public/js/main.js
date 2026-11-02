// 홍보실 — 화면 한 장에 할 일 하나. 시작(이름) → 후보 → 게이트 ①②③ → 노선도.
import { api, API, authed, clearAuth, ApiError } from './api.js';
import { el, svgEl, toast, busy, withBusy, openModal, closeModal, modalOpen, copyText, weekStart, DAY, hm, whenText, toLocalInput, fromLocalInput, ago, STATE_LABEL, ANGLE_LABEL, KIND_NAME, DOW } from './ui.js';
import { renderWeekMap, emptyOverlay } from './linemap.js';

const S = { st: null, sid: '', week: weekStart(Date.now()), timer: 0, pick: '' };
// 「나중에」는 서비스별로 기억한다(탭을 닫으면 잊는다)
Object.defineProperty(S, 'forceHome', {
  get() { try { return sessionStorage.getItem('hongbo.later.' + S.sid) === '1'; } catch { return false; } },
  set(v) { try { if (v) sessionStorage.setItem('hongbo.later.' + S.sid, '1'); else sessionStorage.removeItem('hongbo.later.' + S.sid); } catch { /* 무시 */ } },
});
const $ = (id) => document.getElementById(id);
const app = $('app');

// ---------- 시작 ----------
boot();
async function boot() {
  $('themeBtn').addEventListener('click', () => { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('hongbo.theme', n); } catch { /* 무시 */ } });
  $('logoutBtn').addEventListener('click', () => { clearAuth(); location.hash = ''; location.reload(); });
  $('brandHome').addEventListener('click', (e) => { e.preventDefault(); S.forceHome = false; render(); });
  $('lockForm').addEventListener('submit', onLogin);
  readHash();
  if (!authed()) return showLock();
  await load();
}
function readHash() {
  const q = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  if (q.get('s')) S.sid = q.get('s');
  if (q.get('linked')) { S.forceHome = false; setTimeout(() => toast(`${KIND_NAME[q.get('linked')] || ''} 연결됐습니다 — 노선이 생겼어요`), 400); }
  if (q.get('oauth')) setTimeout(() => toast({ denied: '연결을 취소했습니다', failed: '연결에 실패했습니다 — 기록을 확인해 주세요', bad_state: '연결 요청이 만료됐습니다 — 다시 눌러 주세요', no_code: '연결 코드가 오지 않았습니다', no_service: '서비스를 찾지 못했습니다' }[q.get('oauth')] || '연결 오류', true), 400);
  if (q.get('linked') || q.get('oauth')) history.replaceState(null, '', location.pathname + (S.sid ? `#s=${S.sid}` : ''));
}
function showLock() { $('lock').hidden = false; $('top').hidden = true; app.hidden = true; setTimeout(() => $('lockPw').focus(), 60); }
async function onLogin(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button'); const msg = $('lockMsg'); msg.textContent = '';
  try { await withBusy(btn, () => api.login($('lockPw').value)); $('lock').hidden = true; await load(); }
  catch (err) {
    const card = $('lockForm'); card.classList.remove('wrong'); void card.offsetWidth; card.classList.add('wrong');
    msg.textContent = err.message === 'no_passwords' ? '서버에 암호가 아직 등록되지 않았습니다(PASSWORDS)' : err.message === 'forbidden' ? '이 주소에서는 열 수 없습니다' : '암호가 다릅니다';
    $('lockPw').select();
  }
}

async function load(quiet = false) {
  try {
    S.st = await api.state(S.sid, S.week);
    if (S.st.service) { S.sid = S.st.service.id; history.replaceState(null, '', `#s=${S.sid}`); }
    $('top').hidden = false; app.hidden = false;
    render();
  } catch (err) {
    if (!quiet) toast(err.message === 'no_store' ? '저장소(D1)가 아직 연결되지 않았습니다' : '불러오지 못했습니다 — ' + err.message, true);
  }
}
function schedulePoll() {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => { if (!modalOpen() && !document.querySelector('.svc-menu, .start') && document.querySelector('.home')) await load(true); else schedulePoll(); }, 60000);
}

// ---------- 그리기 ----------
function render() {
  const st = S.st; const svc = st.service;
  renderTop();
  app.innerHTML = '';
  removeDock();
  if (!svc) return app.append(viewStart());
  const gates = st.gates;
  if (!S.forceHome) {
    if (!svc.handle) return app.append(viewPick(svc));
    if (!gates.signup) return app.append(viewGateSignup(svc));
    if (!gates.profile) return app.append(viewGateProfile(svc));
    if (!gates.connect) return app.append(viewGateConnect(svc));
  }
  app.append(viewHome());
  schedulePoll();
}
function removeDock() { document.querySelectorAll('.dock').forEach((d) => d.remove()); }

function renderTop() {
  const st = S.st; const box = $('svcPick'); box.innerHTML = '';
  if (st.service) {
    const b = el('button', { class: 'svc-btn', type: 'button', 'aria-haspopup': 'menu' }, el('b', {}, st.service.name), st.service.handle ? el('small', {}, '@' + st.service.handle) : null, svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', html: '<path d="M6 9l6 6 6-6"/>' }));
    b.addEventListener('click', () => toggleSvcMenu(box));
    box.append(b);
  }
  const sig = $('signals'); sig.innerHTML = '';
  for (const s of st.signals || []) sig.append(el('span', { class: 'sig ' + s.level, title: s.text }, el('i'), el('span', {}, s.text)));
}
function toggleSvcMenu(box) {
  const old = box.querySelector('.svc-menu'); if (old) return old.remove();
  const menu = el('div', { class: 'svc-menu', role: 'menu' });
  for (const s of S.st.services) {
    menu.append(el('button', { type: 'button', class: s.id === S.sid ? 'cur' : '', onclick: () => { S.sid = s.id; S.forceHome = false; menu.remove(); load(); } }, el('i', { class: 'dot' }), el('span', {}, s.name), s.handle ? el('small', { class: 'muted' }, '@' + s.handle) : null));
  }
  menu.append(el('hr'));
  menu.append(el('button', { type: 'button', onclick: () => { menu.remove(); app.innerHTML = ''; removeDock(); app.append(viewStart(true)); } }, el('i', { class: 'dot' }), '새 서비스 계정'));
  if (S.st.service) menu.append(el('button', { type: 'button', onclick: () => { menu.remove(); openModal(viewBriefEdit(), { narrow: true }); } }, el('i', { class: 'dot' }), '서비스 설명 고치기'));
  if (S.st.service) menu.append(el('button', { type: 'button', class: 'danger', onclick: () => { menu.remove(); confirmDelete(); } }, el('i', { class: 'dot' }), '이 서비스 지우기'));
  box.append(menu);
  const off = (e) => { if (!box.contains(e.target)) { menu.remove(); document.removeEventListener('click', off); } };
  setTimeout(() => document.addEventListener('click', off), 0);
}
function confirmDelete() {
  const svc = S.st.service;
  const box = el('div', {}, el('h2', {}, `「${svc.name}」을 지울까요?`), el('p', { class: 'sub' }, '역·소재·연결 기록이 모두 사라집니다. 실제 Instagram·Threads 계정은 그대로입니다.'),
    el('div', { class: 'acts' }, el('span', { class: 'spacer' }), el('button', { class: 'btn', type: 'button', onclick: closeModal }, '그만두기'),
      el('button', { class: 'btn danger', type: 'button', onclick: async (e) => { await withBusy(e.target, () => api.deleteService(svc.id)); closeModal(); S.sid = ''; S.forceHome = false; history.replaceState(null, '', location.pathname); toast('지웠습니다'); load(); } }, '지우기')));
  openModal(box, { narrow: true });
}

// ---------- 시작: 입력 하나 ----------
function viewStart(cancelable = false) {
  const wrap = el('div', { class: 'center' });
  const form = el('form', { class: 'start enter', autocomplete: 'off' });
  const name = el('input', { class: 'big', id: 'svcName', placeholder: '서비스 이름', required: true, maxlength: 60, autofocus: true });
  const home = el('input', { id: 'svcHome', placeholder: '홈페이지 주소 (있으면)', inputmode: 'url' });
  const brief = el('input', { id: 'svcBrief', placeholder: '한 줄 — 누구에게 무엇을 (있으면 후보가 좋아집니다)' });
  const btn = el('button', { class: 'btn ink', type: 'submit' }, '계정 이름 후보 받기');
  form.append(
    el('h1', {}, '어떤 서비스의 계정을 만들까요?'),
    el('div', { style: { display: 'grid', gap: '12px', width: '100%' } }, name, el('div', { class: 'more' }, home, brief)),
    el('div', { class: 'row', style: { display: 'flex', gap: '10px', justifyContent: 'center' } }, cancelable ? el('button', { class: 'btn ghost', type: 'button', onclick: render }, '돌아가기') : null, btn),
    el('p', { class: 'hint' }, S.st && S.st.caps && !S.st.caps.ai ? 'AI 키가 아직 없어 후보 없이 만듭니다(ANTHROPIC_API_KEY)' : '이름을 넣으면 계정 이름 후보를 만듭니다'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await withBusy(btn, () => api.createService({ name: name.value.trim(), homepage: home.value.trim(), brief: brief.value.trim() }));
      S.sid = r.service.id; S.forceHome = false; await load();
    } catch (err) { toast('만들지 못했습니다 — ' + err.message, true); }
  });
  wrap.append(form);
  return wrap;
}

// ---------- 이름 고르기 ----------
// 비었는지는 Instagram 이 판정한다 — ↗ 로 열어 보고 ✓ / ✗ 를 누르면, 있는 이름은 빠지고 새 후보가 채워진다.
const IG_PROFILE = (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`;
const HANDLE_OK = (v) => /^(?!\.)(?!.*\.\.)[a-z0-9._]{1,30}$/.test(v) && !v.endsWith('.');
function viewPick(svc) {
  const wrap = el('div', { class: 'center' });
  const box = el('div', { class: 'pick enter' });
  const list = el('div', { class: 'cands' });
  const confirm = el('button', { class: 'btn ink', type: 'button', disabled: true }, '이 이름으로');
  const note = el('p', { class: 'pick-note', hidden: true }, '확인 전인 이름 — Instagram 가입 화면에서 한 번 더 확인됩니다');
  const hint = el('input', { class: 'inp', id: 'pickHint', placeholder: '바라는 점 — 짧게 · kr 붙여서 · 분야 단어 넣어서 …', maxlength: 200 });
  const again = el('button', { class: 'btn', type: 'button' }, '다시 추천');
  const own = el('input', { class: 'inp', id: 'pickOwn', placeholder: '직접 쓰기', maxlength: 30, spellcheck: 'false', autocapitalize: 'off' });
  const ownCheck = el('a', { class: 'btn sm', target: '_blank', rel: 'noopener', hidden: true }, '↗');
  const takenBar = el('button', { class: 'taken-bar', type: 'button', hidden: true });
  let cands = (svc.candidates || []).slice();
  let showTaken = false;
  let refilling = false;

  const select = (h) => {
    S.pick = h;
    list.querySelectorAll('.cand').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.h === h)));
    const c = cands.find((x) => x.handle === h);
    confirm.disabled = !h || (c && c.check === 'taken');
    note.hidden = !h || (c && c.check === 'free');
  };
  const mark = async (c, check, node) => {
    try {
      if (check === 'taken' && node) { node.classList.add('leaving'); await new Promise((r) => setTimeout(r, 280)); }
      const r = await api.markCandidate(svc.id, c.handle, check);
      cands = r.candidates;
      if (check === 'taken' && S.pick === c.handle) S.pick = '';
      draw();
      if (check === 'taken' && visible().length < 3) refill();
    } catch (err) { node && node.classList.remove('leaving'); toast(err.message, true); }
  };
  const visible = () => cands.filter((c) => c.check !== 'taken');
  const row = (c) => {
    const card = el('div', { class: `cand ck-${c.check || 'unchecked'}`, 'data-h': c.handle, role: 'button', tabindex: '0', 'aria-pressed': String(S.pick === c.handle) });
    const open = el('a', { class: 'ck-open', href: IG_PROFILE(c.handle), target: '_blank', rel: 'noopener', title: 'Instagram 에서 열어 보기', 'aria-label': `@${c.handle} Instagram 에서 열기` }, '↗');
    const yes = el('button', { class: 'ck-btn yes', type: 'button', title: '비었음', 'aria-label': '비었음', 'aria-pressed': String(c.check === 'free') }, '✓');
    const no = el('button', { class: 'ck-btn no', type: 'button', title: '이미 있음', 'aria-label': '이미 있음', 'aria-pressed': String(c.check === 'taken') }, '✕');
    open.addEventListener('click', (e) => { e.stopPropagation(); card.classList.add('opened'); });
    yes.addEventListener('click', (e) => { e.stopPropagation(); mark(c, c.check === 'free' ? 'unchecked' : 'free', card); });
    no.addEventListener('click', (e) => { e.stopPropagation(); mark(c, c.check === 'taken' ? 'unchecked' : 'taken', card); });
    card.addEventListener('click', () => { if (c.check !== 'taken') select(c.handle); });
    card.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && c.check !== 'taken') { e.preventDefault(); select(c.handle); } });
    card.append(el('i', { class: 'av' }), el('div', { class: 'h' }, '@' + c.handle, c.why ? el('small', {}, c.why) : null), el('div', { class: 'ck' }, open, yes, no));
    return card;
  };
  function draw() {
    list.innerHTML = '';
    const vis = visible();
    if (!vis.length) list.append(el('p', { class: 'muted', style: { textAlign: 'center', margin: '8px 0' } }, S.st.caps.ai ? '후보가 없습니다 — 다시 추천을 눌러 주세요' : 'AI 키가 없어 후보가 없습니다 — 직접 써 주세요'));
    // 비었음 → 확인 전 순서
    vis.sort((a, b) => (a.check === 'free' ? 0 : 1) - (b.check === 'free' ? 0 : 1)).forEach((c, i) => { const r = row(c); r.style.animationDelay = `${i * 40}ms`; list.append(r); });
    const taken = cands.filter((c) => c.check === 'taken');
    takenBar.hidden = !taken.length;
    takenBar.textContent = `있는 이름 ${taken.length}`;
    if (showTaken) taken.forEach((c) => list.append(row(c)));
    select(S.pick && cands.some((c) => c.handle === S.pick && c.check !== 'taken') ? S.pick : (S.pick && own.value ? S.pick : ''));
  }
  async function refill() {
    if (refilling || !S.st.caps.ai) return;
    refilling = true;
    try { const r = await withBusy(again, () => api.candidates(svc.id, hint.value.trim())); cands = r.candidates; draw(); }
    catch (err) { toast(err.message === 'no_key' ? 'AI 키가 없습니다' : '후보를 못 만들었습니다', true); }
    finally { refilling = false; }
  }
  again.addEventListener('click', () => { S.pick = ''; refill(); });
  hint.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); S.pick = ''; refill(); } });
  takenBar.addEventListener('click', () => { showTaken = !showTaken; draw(); });
  own.addEventListener('input', () => {
    const v = own.value.trim().toLowerCase().replace(/^@/, '');
    const okName = HANDLE_OK(v);
    ownCheck.hidden = !okName; if (okName) ownCheck.href = IG_PROFILE(v);
    own.classList.toggle('bad', !!v && !okName);
    const known = cands.find((c) => c.handle === v);
    if (known && known.check === 'taken') { select(''); own.classList.add('bad'); return; }
    select(okName ? v : '');
  });
  confirm.addEventListener('click', async () => {
    try { await withBusy(confirm, () => api.handle(svc.id, S.pick)); await load(); }
    catch (err) { toast(err.message === 'bad_handle' ? '쓸 수 없는 이름입니다' : err.message === 'handle_taken' ? '이미 있다고 표시한 이름입니다' : err.message, true); }
  });
  draw();
  box.append(
    el('h2', {}, `${svc.name} — 계정 이름`),
    el('div', { class: 'hintbar' }, hint, again),
    list,
    el('div', { class: 'pick-legend' }, el('span', {}, el('b', {}, '↗'), ' Instagram 에서 열어 보고'), el('span', { class: 'yes' }, '✓ 비었음'), el('span', { class: 'no' }, '✕ 있음'), takenBar),
    el('div', { class: 'own' }, own, ownCheck),
    note,
    el('div', { class: 'row' }, confirm),
  );
  wrap.append(box);
  return wrap;
}

// ---------- 게이트 공통 ----------
function gateCard({ n, title, mins, chip, children, acts }) {
  return el('div', { class: 'center' }, el('section', { class: 'gatecard enter' },
    el('div', {}, el('span', { class: 'chip gate' }, chip || `게이트 ${['①', '②', '③'][n - 1]} · 사람 ${mins}`)),
    el('h2', {}, title), ...children, el('div', { class: 'acts' }, ...acts)));
}
const copyRow = (text, one = false) => el('div', { class: 'copyrow' }, el('code', { class: one ? 'one' : '' }, text), el('button', { class: 'btn sm', type: 'button', onclick: () => copyText(text) }, '복사'));
const later = () => el('button', { class: 'btn ghost later', type: 'button', onclick: () => { S.forceHome = true; render(); } }, '나중에');

// 게이트 ① 가입 — 암호·전화번호는 Instagram 에만. 이 화면은 받지 않는다.
function viewGateSignup(svc) {
  const done = el('button', { class: 'btn ink', type: 'button' }, '만들었어요');
  done.addEventListener('click', async () => { try { await withBusy(done, () => api.gate(svc.id, 'signup', true)); await load(); } catch (err) { toast(err.message, true); } });
  const taken = el('button', { class: 'btn', type: 'button' }, '이미 있대요');
  taken.addEventListener('click', async () => { try { await withBusy(taken, () => api.markCandidate(svc.id, svc.handle, 'taken')); toast(`@${svc.handle} 은 빼고 다시 고릅니다`); await load(); } catch (err) { toast(err.message, true); } });
  const field = (label, text) => el('div', { class: 'field-copy' }, el('span', {}, label), copyRow(text, true));
  return gateCard({
    n: 1, title: 'Instagram 계정을 만들어 주세요', mins: '3분',
    children: [
      el('p', {}, '암호·전화번호는 Instagram 에만 넣습니다. 사용자 이름 칸에 붙여넣으면 Instagram 이 바로 쓸 수 있는지 알려 줍니다.'),
      field('이름', svc.name),
      field('사용자 이름', svc.handle),
      el('ul', { class: 'steps' },
        el('li', {}, el('i', {}, '1'), el('span', {}, '가입 화면 → 이메일 · 이름 · 사용자 이름 · 암호')),
        el('li', {}, el('i', {}, '2'), el('span', {}, '설정 › 계정 유형 → 프로페셔널(비즈니스·크리에이터)')),
        el('li', {}, el('i', {}, '3'), el('span', {}, 'Threads 앱 → 같은 계정으로 로그인'))),
    ],
    acts: [el('a', { class: 'btn', href: 'https://www.instagram.com/accounts/emailsignup/', target: '_blank', rel: 'noopener' }, '가입 열기'), done, taken, later()],
  });
}

// 게이트 ③ 연결 — 클릭만. 끝나면 노선이 생긴다. 관리자 설정(Meta 앱)이 아직이면 막지 않고 둘러보게 한다.
function viewGateConnect(svc) {
  const st = S.st;
  const adminReady = (st.caps.ig || st.caps.th) && st.caps.secret;
  const browse = el('button', { class: 'btn ink', type: 'button', onclick: () => { S.forceHome = true; render(); } }, '먼저 둘러보기');
  if (!adminReady) {
    return gateCard({
      n: 3, title: '연결 준비가 한 번 남았습니다', chip: '게이트 ③ · 관리자 한 번',
      children: [
        el('p', {}, '홍보실이 Instagram·Threads 에 글을 올리려면 Meta 쪽 출입증(앱)이 하나 필요합니다. 관리자가 한 번 만들어 두면, 이 화면에서 계정마다 「연결」 버튼 하나로 끝납니다.'),
        el('p', {}, '그동안 소재 넣기·운영 규칙 정하기는 먼저 해 둘 수 있습니다.'),
        el('details', { class: 'admin' }, el('summary', {}, '관리자용 — 출입증 만드는 법'),
          el('ol', {},
            el('li', {}, 'developers.facebook.com › 앱 만들기 → Instagram(Instagram 로그인) · Threads API 추가'),
            el('li', {}, '되돌아올 주소 두 개 등록 — ', el('code', {}, `${st.caps.origin}/api/oauth/ig/callback`), ' · ', el('code', {}, `${st.caps.origin}/api/oauth/th/callback`)),
            el('li', {}, '앱 ID·시크릿을 Cloudflare › pensieve-instagram › 빌드 › 변수 및 암호에 비밀로 — IG_APP_ID · IG_APP_SECRET · THREADS_APP_ID · THREADS_APP_SECRET'),
            el('li', {}, '앱 역할 › 테스터에 연결할 Instagram 계정 추가(심사 전까지)'))),
      ],
      acts: [browse],
    });
  }
  const row = (kind) => {
    const ch = st.channels.find((c) => c.kind === kind && c.hasToken);
    const r = el('div', { class: 'linkrow ' + kind }, el('i'), el('b', {}, KIND_NAME[kind]), ch ? el('span', { class: 'muted' }, '@' + ch.username) : null);
    if (ch && ch.status === 'linked') r.append(el('span', { class: 'ok' }, '연결됨'));
    else if (!st.caps[kind]) r.append(el('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '12.5px' } }, '준비 중'));
    else {
      const b = el('button', { class: 'btn sm ink', type: 'button' }, ch ? '다시 연결' : '연결');
      b.addEventListener('click', () => connect(kind, b));
      r.append(b);
    }
    return r;
  };
  const anyLinked = st.channels.some((c) => c.hasToken && c.status === 'linked');
  const next = el('button', { class: 'btn ink', type: 'button', disabled: !anyLinked }, '다음');
  next.addEventListener('click', async () => { try { await withBusy(next, () => api.gate(svc.id, 'connect', true)); await load(); } catch (err) { toast(err.message, true); } });
  return gateCard({
    n: 3, title: '계정을 홍보실에 연결해 주세요', mins: '1분',
    children: [
      el('p', {}, '누르면 Meta 로그인 창이 열립니다. 허용하면 끝 — 열쇠는 홍보실이 알아서 갱신합니다.'),
      el('div', { class: 'links' }, row('ig'), row('th')),
      el('p', { class: 'muted', style: { fontSize: '13px' } }, '연결이 안 되면: Instagram 이 프로페셔널 계정인지, 관리자가 이 계정을 Meta 앱 테스터로 넣었는지 확인해 주세요.'),
    ],
    acts: [next, later()],
  });
}

// 게이트 ③ 프로필 — 설명(사람) → 소개문 3안(AI) → 고르고 고치기(사람) → 붙여넣기(사람). API 가 프로필 수정을 막아 둬서.
function viewGateProfile(svc) {
  const st = S.st;
  const wrap = el('div');
  const prof = () => st.settings.profile || {};
  let step = !svc.brief || !(prof().options || []).length ? 'desc' : (!svc.bio ? 'pick' : 'paste');
  const dots = (cur) => el('div', { class: 'stepdots', 'aria-label': '단계' }, ...['desc', 'pick', 'paste'].map((k, i) => el('i', { class: k === cur ? 'on' : (['desc', 'pick', 'paste'].indexOf(cur) > i ? 'done' : '') })));
  const draw = () => {
    wrap.innerHTML = '';
    if (step === 'desc') {
      const brief = el('textarea', { class: 'inp', id: 'profBrief', placeholder: '누구에게 무엇을 해 주는 서비스인가요? 한두 문장이면 됩니다', maxlength: 2000 }, svc.brief || '');
      const home = el('input', { class: 'inp', id: 'profHome', placeholder: '링크 — 홈페이지·소개 페이지 (있으면)', value: svc.homepage || '', inputmode: 'url' });
      const gen = el('button', { class: 'btn ink', type: 'button' }, '소개문 3안 만들기');
      gen.addEventListener('click', async () => {
        if (brief.value.trim().length < 5) { brief.focus(); brief.classList.add('bad'); return toast('한두 문장만 적어 주세요', true); }
        try {
          const r = await withBusy(gen, () => api.profile(svc.id, { brief: brief.value.trim(), homepage: home.value.trim() }));
          st.settings.profile = r.profile; svc.brief = brief.value.trim(); svc.homepage = home.value.trim(); step = 'pick'; draw();
        } catch (err) { toast(err.message === 'no_key' ? 'AI 키가 없습니다' : err.message === 'brief_required' ? '설명을 조금 더 적어 주세요' : '못 만들었습니다 — ' + err.message, true); }
      });
      wrap.append(gateCard({ n: 2, title: '어떤 서비스인가요?', mins: '1분', children: [dots('desc'), el('p', {}, '여기 적은 내용으로만 소개문을 만듭니다. 없는 기능은 쓰지 않습니다.'), brief, home], acts: [gen, later()] }));
      return;
    }
    if (step === 'pick') {
      const opts = prof().options || [];
      let chosen = svc.bio || (opts[0] && opts[0].bio) || '';
      const ta = el('textarea', { class: 'inp', id: 'profBio', maxlength: 150 }, chosen);
      const count = el('div', { class: 'count' }, `${chosen.length} / 150`);
      ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / 150`; list.querySelectorAll('.opt').forEach((o) => o.setAttribute('aria-pressed', 'false')); });
      const list = el('div', { class: 'opts' }, ...opts.map((o, i) => {
        const b = el('button', { class: 'opt', type: 'button', 'aria-pressed': String(o.bio === chosen) }, el('small', {}, `${i + 1}안 · ${o.why || ''}`), el('span', {}, o.bio));
        b.addEventListener('click', () => { ta.value = o.bio; count.textContent = `${o.bio.length} / 150`; list.querySelectorAll('.opt').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
        return b;
      }));
      const use = el('button', { class: 'btn ink', type: 'button' }, '이걸로');
      use.addEventListener('click', async () => { try { const r = await withBusy(use, () => api.bio(svc.id, ta.value.trim())); st.settings.profile = r.profile; svc.bio = r.profile.bio; step = 'paste'; draw(); } catch (err) { toast(err.message === 'bio_too_long' ? '150자를 넘었습니다' : err.message === 'bio_required' ? '소개문이 비었습니다' : err.message, true); } });
      const back = el('button', { class: 'btn ghost', type: 'button', onclick: () => { step = 'desc'; draw(); } }, '설명 고치기');
      wrap.append(gateCard({ n: 2, title: '소개문을 골라 주세요', mins: '1분', children: [dots('pick'), list, ta, count], acts: [use, back, later()] }));
      return;
    }
    const p = prof();
    const img = el('img', { alt: '프로필 이미지 미리보기', src: '' });
    api.blob(`/api/services/${svc.id}/profile-image.svg`).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
    const dl = el('button', { class: 'btn sm', type: 'button' }, st.caps.render ? 'JPG 받기' : 'SVG 받기');
    dl.addEventListener('click', async () => {
      try {
        const b = await withBusy(dl, () => api.blob(`/api/services/${svc.id}/profile-image.${st.caps.render ? 'jpg' : 'svg'}`));
        const a = el('a', { href: URL.createObjectURL(b), download: `${svc.handle}-profile.${st.caps.render ? 'jpg' : 'svg'}` }); document.body.append(a); a.click(); a.remove();
      } catch (err) { toast('내려받지 못했습니다', true); }
    });
    const done = el('button', { class: 'btn ink', type: 'button' }, '넣었어요');
    done.addEventListener('click', async () => { try { await withBusy(done, () => api.gate(svc.id, 'profile', true)); S.forceHome = false; await load(); } catch (err) { toast(err.message, true); } });
    const back = el('button', { class: 'btn ghost', type: 'button', onclick: () => { step = (p.options || []).length ? 'pick' : 'desc'; draw(); } }, '소개 고치기');
    wrap.append(gateCard({
      n: 2, title: '프로필에 붙여넣어 주세요', mins: '1분',
      children: [
        dots('paste'),
        el('div', { class: 'pic' }, img, el('div', { style: { display: 'grid', gap: '6px' } }, el('b', {}, '프로필 이미지'), el('span', { class: 'muted', style: { fontSize: '13px' } }, '로고가 있으면 로고를'), dl)),
        el('div', { class: 'field-copy' }, el('span', {}, '소개'), copyRow(svc.bio || p.bio || '')),
        svc.homepage ? el('div', { class: 'field-copy' }, el('span', {}, '링크'), copyRow(svc.homepage, true)) : null,
        el('ul', { class: 'steps' },
          el('li', {}, el('i', {}, 'I'), el('span', {}, 'Instagram 프로필 편집 → 사진 · 소개 · 링크')),
          el('li', {}, el('i', {}, 'T'), el('span', {}, 'Threads 앱 › 프로필 편집 → 소개'))),
      ],
      acts: [el('a', { class: 'btn', href: 'https://www.instagram.com/accounts/edit/', target: '_blank', rel: 'noopener' }, '프로필 편집 열기'), done, back, later()],
    }));
  };
  draw();
  return wrap;
}

// ---------- 홈 · 노선도 ----------
function viewHome() {
  const st = S.st; const svc = st.service;
  const home = el('div', { class: 'home stage' });
  const pending = st.gates.signup && st.gates.connect && st.gates.profile ? 0 : 1;
  const chIg = st.channels.find((c) => c.kind === 'ig'); const chTh = st.channels.find((c) => c.kind === 'th');
  const head = (kind, ch) => {
    const ok = ch && ch.hasToken && ch.status === 'linked';
    const node = el(ok ? 'span' : 'button', { class: `linehead ${kind}${ok ? '' : ' off'}`, type: ok ? null : 'button', title: ok ? '' : '눌러서 연결' }, el('i'), KIND_NAME[kind], el('small', {}, ok ? '@' + ch.username : (ch && ch.hasToken ? '만료 — 다시 연결' : '연결 안 됨 — 연결')));
    if (!ok) node.addEventListener('click', () => connect(kind, node));
    return node;
  };
  const title = el('h2', {}, weekTitle());
  const bar = el('div', { class: 'weekbar' },
    el('div', { class: 'nav' }, el('button', { class: 'icon-btn', type: 'button', 'aria-label': '지난주', onclick: () => { S.week -= 7 * DAY; load(true); } }, svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', html: '<path d="M15 6l-6 6 6 6"/>' })), el('button', { class: 'icon-btn', type: 'button', 'aria-label': '다음 주', onclick: () => { S.week += 7 * DAY; load(true); } }, svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', html: '<path d="M9 6l6 6-6 6"/>' }))),
    title,
    S.week !== weekStart(Date.now()) ? el('button', { class: 'btn sm ghost today-btn', type: 'button', onclick: () => { S.week = weekStart(Date.now()); load(true); } }, '이번 주') : null,
    el('div', { class: 'right' }, head('ig', chIg), head('th', chTh)),
  );
  const mapwrap = el('div', { class: 'mapwrap' });
  const weekPosts = st.posts.filter((p) => p.scheduled_at >= S.week && p.scheduled_at < S.week + 7 * DAY);
  mapwrap.append(renderWeekMap({ weekStart: S.week, posts: st.posts, channels: st.channels, now: st.now, onStation: openPost, onPlus: (kind, node) => plan([kind], node) }));
  const linked = st.channels.some((c) => c.hasToken && c.status === 'linked');
  if (!weekPosts.length && S.week >= weekStart(Date.now())) {
    mapwrap.append(emptyOverlay(linked ? (st.materials.length ? '이번 주 역 세우기' : '소재부터 넣기') : '계정 연결부터', (e) => { if (!linked) connect(st.channels.some((c) => c.kind === 'ig' && c.hasToken) ? 'th' : 'ig', e.currentTarget); else if (!st.materials.length) openMaterials(); else plan(null, e.currentTarget); }));
  }
  home.append(bar, mapwrap, belowSheets());
  // 독 — 할 일 하나씩
  const review = st.posts.filter((p) => p.state === 'review').length;
  const dock = el('div', { class: 'dock' },
    el('button', { class: 'btn ink', type: 'button', disabled: !linked, onclick: () => plan() }, '이번 주 채우기'),
    el('button', { class: 'btn', type: 'button', onclick: () => openReviewQueue() }, '승인', review ? el('span', { class: 'n' }, review) : null),
    el('button', { class: 'btn', type: 'button', onclick: openMaterials }, '소재', st.materials.length ? el('span', { class: 'n', style: { background: 'var(--paper-desk)', color: 'var(--ink)' } }, st.materials.length) : null),
    el('button', { class: 'btn', type: 'button', onclick: openSettings }, '설정'),
    pending ? el('button', { class: 'btn hi', type: 'button', onclick: () => { S.forceHome = false; render(); } }, '게이트') : null,
  );
  document.body.append(dock);
  return home;
}
async function connect(kind, btn) {
  const st = S.st;
  if (!st.caps[kind] || !st.caps.secret) { S.forceHome = false; st.gates.connect = 0; render(); return toast('연결 준비(관리자 설정)가 아직입니다', true); }
  try { const { url } = await withBusy(btn, () => api.oauthStart(st.service.id, kind)); location.href = url; }
  catch (err) { toast(err.message === 'no_app' || err.message === 'no_secret' ? '연결 준비(관리자 설정)가 아직입니다' : err.message, true); }
}
function weekTitle() { const a = S.week; const b = a + 6 * DAY; const ka = new Date(a + 9 * 3600e3); const kb = new Date(b + 9 * 3600e3); return `${ka.getUTCMonth() + 1}.${ka.getUTCDate()} – ${kb.getUTCMonth() + 1}.${kb.getUTCDate()}`; }

function belowSheets() {
  const st = S.st; const wrap = el('div', { class: 'below' });
  // 요약
  const daily = st.daily;
  const sum = el('div', { class: 'sheet' }, el('h3', {}, daily ? `${daily.day} 요약` : '요약'));
  if (daily && daily.text) sum.append(el('p', { class: 'big' }, daily.text.headline || ''), el('ul', {}, ...(daily.text.lines || []).map((l) => el('li', {}, l))), daily.text.next ? el('div', { class: 'next' }, daily.text.next) : null);
  else if (daily) sum.append(el('ul', {}, el('li', {}, `게시 ${daily.stats.posted} · 실패 ${daily.stats.failed}`)));
  else sum.append(el('p', { class: 'muted', style: { fontSize: '13.5px', margin: 0 } }, '매일 아침 9시에 어제 요약이 여기 뜹니다.'));
  const syncBtn = el('button', { class: 'btn sm ghost', type: 'button', style: { marginTop: '8px' } }, '지금 지표 가져오기');
  syncBtn.addEventListener('click', async () => { try { await withBusy(syncBtn, () => api.sync(st.service.id)); toast('가져왔습니다'); await load(true); } catch (err) { toast('지표를 못 가져왔습니다 — ' + err.message, true); } });
  sum.append(syncBtn);
  // 숫자
  const nums = el('div', { class: 'sheet' }, el('h3', {}, '팔로워 · 이번 주'));
  const row = el('div', { class: 'nums' });
  for (const kind of ['ig', 'th']) {
    const ch = st.channels.find((c) => c.kind === kind);
    const f = ch && ch.meta && ch.meta.followers != null ? ch.meta.followers : null;
    const d = daily && daily.stats && daily.stats.delta ? daily.stats.delta[kind] : null;
    row.append(el('div', {}, el('b', { class: 'num' }, f == null ? '–' : f.toLocaleString()), el('small', {}, KIND_NAME[kind] + (d != null ? '' : ' 팔로워')), d != null ? el('span', { class: 'd' + (d < 0 ? ' neg' : '') }, (d >= 0 ? '+' : '') + d) : null));
  }
  const weekPosts = st.posts.filter((p) => p.scheduled_at >= S.week && p.scheduled_at < S.week + 7 * DAY && p.state !== 'skipped');
  row.append(el('div', {}, el('b', { class: 'num' }, String(weekPosts.filter((p) => p.state === 'posted').length)), el('small', {}, `게시됨 / ${weekPosts.length} 예정`)));
  nums.append(row);
  // 기록
  const ev = el('div', { class: 'sheet' }, el('h3', {}, '기록'));
  const list = el('div', { class: 'events' });
  for (const e of st.events || []) list.append(el('div', { class: 'ev ' + e.level }, el('time', {}, ago(e.at)), el('span', {}, `${e.kind.replace(/\./g, ' · ')}${e.detail ? ' — ' + e.detail : ''}`)));
  if (!(st.events || []).length) list.append(el('span', { class: 'muted', style: { fontSize: '13px' } }, '아직 없습니다'));
  ev.append(list);
  wrap.append(sum, nums, ev);
  return wrap;
}

let planning = false;
async function plan(channels, btn) {
  const st = S.st;
  if (planning) return;
  if (!st.caps.ai) return toast('AI 키가 없어 글을 만들 수 없습니다(ANTHROPIC_API_KEY)', true);
  const dockBtn = document.querySelector('.dock .btn.ink');
  toast('역을 세우는 중 — 글을 쓰고 다듬고 카드를 찍습니다');
  planning = true;
  try {
    busy(btn, true);
    const r = await withBusy(dockBtn, () => api.plan(st.service.id, { days: 7, channels, from: S.week }));
    toast(r.made.length ? `역 ${r.made.length}개를 세웠습니다 — ${st.settings.approval === 'auto' ? '시간이 되면 올라갑니다' : '눌러서 승인해 주세요'}` : '세울 자리가 없습니다 — 이미 다 찼거나 슬롯이 없습니다');
    await load(true);
  } catch (err) { toast('못 세웠습니다 — ' + (err.body && err.body.detail || err.message), true); }
  finally { planning = false; busy(btn, false); }
}

// ---------- 역 상세 ----------
function openPost(post) {
  const st = S.st; const svc = st.service;
  const box = el('div');
  const draw = (p) => {
    box.innerHTML = '';
    const state = el('span', { class: 'chip state-' + p.state }, STATE_LABEL[p.state] || p.state);
    box.append(el('div', { class: 'meta-row' }, el('span', { class: 'chip ' + p.channel }, KIND_NAME[p.channel]), state, el('span', { class: 'chip' }, ANGLE_LABEL[p.angle] || p.angle), el('span', { class: 'muted', style: { fontSize: '13px' } }, whenText(p.scheduled_at))));
    const grid = el('div', { class: 'post' });
    // 미리보기
    const pv = el('div', { class: 'preview' });
    if (p.channel === 'ig') {
      const card = el('div', { class: 'ig-card' });
      if (p.media[0]) card.append(el('img', { src: p.media[0].url, alt: p.alt || '' }));
      else if (p.card) card.append(el('div', { class: 'fake' }, el('div', { class: 'rail' }), el('h4', {}, p.card.headline), p.card.sub ? el('p', {}, p.card.sub) : null, (p.card.bullets || []).length ? el('ul', {}, ...p.card.bullets.map((b) => el('li', {}, b))) : null, el('div', { class: 'foot' }, '@' + svc.handle)));
      else card.append(el('div', { class: 'none' }, '이미지 없음', el('small', {}, '소재 이미지를 올리거나 카드 렌더(BROWSER)를 켜 주세요')));
      pv.append(card);
      if (!p.media[0] && p.card) pv.append(el('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } }, '카드 미리보기 — 이미지가 아직 없습니다. 「다시 쓰기」를 누르면 카드를 찍습니다(렌더가 켜져 있을 때)'));
    } else {
      pv.append(el('div', { class: 'th-post' }, el('div', { class: 'av' }, (svc.name || 'P').slice(0, 1)), el('div', {}, el('div', { class: 'who' }, svc.handle, el('small', {}, hm(p.scheduled_at))), el('div', { class: 'body' }, p.text))));
    }
    // 고치기
    const ed = el('div', { class: 'edit' });
    const hook = el('input', { class: 'inp', value: p.hook, maxlength: 60, 'aria-label': '첫 줄' });
    const text = el('textarea', { class: 'inp', 'aria-label': '본문' }, p.text);
    const limit = p.channel === 'ig' ? 2200 : 500;
    const count = el('div', { class: 'count' }, `${p.text.length} / ${limit}`);
    text.addEventListener('input', () => { count.textContent = `${text.value.length} / ${limit}`; count.classList.toggle('over', text.value.length > limit); if (p.channel === 'th') pv.querySelector('.body').textContent = text.value; });
    const tags = p.channel === 'ig' ? el('input', { class: 'inp', value: p.hashtags, placeholder: '해시태그 (띄어쓰기로, 5개 안)', 'aria-label': '해시태그' }) : null;
    const when = el('input', { type: 'datetime-local', value: toLocalInput(p.scheduled_at), 'aria-label': '게시 시각' });
    ed.append(el('label', { class: 'field' }, el('span', {}, '첫 줄'), hook), el('label', { class: 'field' }, el('span', {}, p.channel === 'ig' ? '캡션' : '글'), text, count), tags ? el('label', { class: 'field' }, el('span', {}, '해시태그'), tags) : null, el('div', { class: 'when' }, el('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 600 } }, '게시 시각(KST)'), when));
    if (p.error) ed.append(el('div', { class: 'err' }, p.error));
    if (p.state === 'posted') {
      const m = p.metrics || {};
      ed.append(el('div', { class: 'metrics' }, el('span', {}, '♥ ', el('b', {}, m.likes ?? '–')), el('span', {}, '댓글 ', el('b', {}, m.comments ?? '–')), m.reach != null ? el('span', {}, '도달 ', el('b', {}, m.reach)) : null, m.views != null ? el('span', {}, '뷰 ', el('b', {}, m.views)) : null, p.permalink ? el('a', { href: p.permalink, target: '_blank', rel: 'noopener' }, '게시물 열기') : null));
    }
    // 동작
    const acts = el('div', { class: 'acts' });
    const editable = !['posted', 'publishing', 'skipped'].includes(p.state);
    const patch = () => ({ hook: hook.value, text: text.value, hashtags: tags ? tags.value : undefined, scheduled_at: fromLocalInput(when.value) || p.scheduled_at });
    const run = async (btn, fn, msg) => { try { const r = await withBusy(btn, fn); if (msg) toast(msg); await load(true); if (r && r.post) draw(r.post); else closeModal(); } catch (err) { toast(err.message === 'bad_transition' ? '지금 상태에서는 할 수 없습니다' : '실패 — ' + (err.body && err.body.detail || err.message), true); } };
    if (editable) {
      if (p.state !== 'scheduled') acts.append(el('button', { class: 'btn ink', type: 'button', onclick: (e) => run(e.currentTarget, () => api.post(svc.id, p.id, { action: 'approve', ...patch() }), '승인 — 시간이 되면 올라갑니다') }, p.state === 'failed' ? '고쳐서 다시' : '승인'));
      acts.append(el('button', { class: 'btn', type: 'button', onclick: (e) => run(e.currentTarget, () => api.post(svc.id, p.id, { action: 'edit', ...patch() }), '저장했습니다') }, '저장'));
      if (p.state === 'scheduled') acts.append(el('button', { class: 'btn', type: 'button', onclick: (e) => run(e.currentTarget, () => api.post(svc.id, p.id, { action: 'hold' }), '승인 대기로 돌렸습니다') }, '다시 검토'));
      acts.append(el('button', { class: 'btn', type: 'button', onclick: (e) => run(e.currentTarget, () => api.regenerate(svc.id, p.id), '다시 썼습니다') }, '다시 쓰기'));
      acts.append(el('span', { class: 'spacer' }));
      acts.append(el('button', { class: 'btn', type: 'button', onclick: (e) => { const b = e.currentTarget; if (b.dataset.sure) run(b, () => api.postNow(svc.id, p.id), '보냈습니다'); else { b.dataset.sure = '1'; b.textContent = '정말 지금?'; setTimeout(() => { delete b.dataset.sure; b.textContent = '지금 게시'; }, 2500); } } }, '지금 게시'));
      acts.append(el('button', { class: 'btn ghost danger', type: 'button', onclick: (e) => run(e.currentTarget, () => api.post(svc.id, p.id, { action: 'skip' }), '건너뜁니다') }, '건너뜀'));
    } else if (p.state === 'publishing') acts.append(el('span', { class: 'muted', style: { fontSize: '13.5px' } }, '게시 중 — 5분 안에 상태가 바뀝니다'));
    else if (p.state === 'skipped') acts.append(el('span', { class: 'muted', style: { fontSize: '13.5px' } }, '건너뛴 자리 — 이 시각에는 올리지 않습니다'));
    [hook, text, when, tags].forEach((x) => { if (x) x.disabled = !editable; });
    grid.append(pv, el('div', {}, ed, acts));
    box.append(grid);
  };
  draw(post);
  openModal(box);
}

function openReviewQueue() {
  const st = S.st; const list = st.posts.filter((p) => p.state === 'review').sort((a, b) => a.scheduled_at - b.scheduled_at);
  if (!list.length) return toast('승인 대기 중인 역이 없습니다');
  openPost(list[0]);
}

// ---------- 소재 창고 ----------
function openMaterials() {
  const st = S.st; const svc = st.service;
  const box = el('div', { class: 'mats' });
  const draw = () => {
    box.innerHTML = '';
    box.append(el('h2', {}, '소재 창고'), el('p', { class: 'sub' }, '제품 이미지(JPG) · 설명 글(.md/.txt) · 홈페이지 링크. 글은 사실만 추려 두었다가 게시물에 씁니다.'));
    const drop = el('label', { class: 'drop' }, el('b', {}, '이미지나 글 파일을 끌어다 놓기'), el('span', {}, 'JPG · PNG · WebP · .md · .txt — 또는 눌러서 고르기'), el('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,.md,.txt,text/plain,text/markdown' }));
    const input = drop.querySelector('input');
    const upload = async (files) => {
      for (const f of files) {
        const fd = new FormData(); fd.append('file', f); fd.append('title', f.name.replace(/\.[^.]+$/, ''));
        try { await api.addMaterial(svc.id, fd); toast(`${f.name} 올렸습니다`); }
        catch (err) { toast(`${f.name}: ${err.body && err.body.hint || err.message}`, true); }
      }
      await load(true); draw();
    };
    input.addEventListener('change', () => upload([...input.files]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });
    const link = el('input', { class: 'inp', placeholder: '링크 — 홈페이지·소개 페이지', inputmode: 'url' });
    const linkBtn = el('button', { class: 'btn', type: 'button' }, '읽어 오기');
    linkBtn.addEventListener('click', async () => { if (!link.value.trim()) return; try { await withBusy(linkBtn, () => api.addMaterial(svc.id, { type: 'link', url: link.value.trim() })); link.value = ''; toast('읽어 왔습니다'); await load(true); draw(); } catch (err) { toast('못 읽었습니다 — ' + (err.body && err.body.detail || err.message), true); } });
    const text = el('textarea', { class: 'inp', placeholder: '직접 쓰기 — 설명·공지·수치(출처와 함께)', style: { minHeight: '80px' } });
    const textBtn = el('button', { class: 'btn', type: 'button' }, '넣기');
    textBtn.addEventListener('click', async () => { if (!text.value.trim()) return; try { await withBusy(textBtn, () => api.addMaterial(svc.id, { type: 'text', text: text.value.trim() })); text.value = ''; toast('넣었습니다'); await load(true); draw(); } catch (err) { toast(err.message, true); } });
    const list = el('div', { class: 'matlist' });
    for (const m of S.st.materials) {
      const card = el('div', { class: 'mat' });
      if (m.type === 'image') card.append(el('img', { src: m.url, alt: m.title }));
      else card.append(el('div', { class: 'ico' }, m.type === 'link' ? '🔗' : 'Aa'));
      card.append(el('b', { title: m.title }, m.title || m.type), el('span', { class: 'sum' }, (m.summary && m.summary.summary) || (m.url || '').replace(/^https?:\/\//, '') || m.text.slice(0, 80)));
      card.append(el('button', { class: 'del', type: 'button', 'aria-label': '지우기', onclick: async (e) => { const b = e.currentTarget; if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '?'; setTimeout(() => { delete b.dataset.sure; b.textContent = '×'; }, 2000); return; } try { await api.deleteMaterial(svc.id, m.id); await load(true); draw(); } catch (err) { toast(err.message, true); } } }, '×'));
      list.append(card);
    }
    box.append(drop, el('div', { class: 'addrow' }, link, linkBtn), el('div', { class: 'addrow' }, text, textBtn), S.st.materials.length ? list : el('p', { class: 'muted', style: { fontSize: '13.5px', margin: 0 } }, '아직 소재가 없습니다. 서비스 설명만으로도 글은 쓸 수 있지만, Instagram 은 이미지가 있어야 올라갑니다.'));
  };
  draw();
  openModal(box);
}

// ---------- 설정 ----------
function openSettings() {
  const st = S.st; const svc = st.service; const s = JSON.parse(JSON.stringify(st.settings));
  const box = el('div', { class: 'settings' });
  const draw = () => {
    box.innerHTML = '';
    box.append(el('h2', {}, '운영 규칙'), el('p', { class: 'sub' }, '적게 올리되 매번 또렷하게. 슬롯이 곧 빈도입니다 — 그 시각에만 역이 섭니다.'));
    for (const kind of ['ig', 'th']) {
      const row = el('div', { class: 'slots' });
      row.append(el('span', { class: 'linehead ' + kind }, el('i'), KIND_NAME[kind], el('small', {}, `주 ${s[kind].slots.length}회`)));
      s[kind].slots.forEach((sl, i) => row.append(el('span', { class: 'slot' }, `${DOW[sl.dow]} ${sl.hm}`, el('button', { type: 'button', 'aria-label': '빼기', onclick: () => { s[kind].slots.splice(i, 1); draw(); } }, '×'))));
      const dow = el('select', {}, ...DOW.map((d, i) => el('option', { value: i, selected: i === 2 }, d)));
      const time = el('input', { type: 'time', value: kind === 'ig' ? '20:00' : '12:30' });
      row.append(el('span', { class: 'slot-add' }, dow, time, el('button', { class: 'btn sm', type: 'button', onclick: () => { if (!time.value) return; s[kind].slots.push({ dow: Number(dow.value), hm: time.value }); draw(); } }, '+')));
      box.append(row);
    }
    const seg = el('div', { class: 'seg' }, ...[['review', '승인 후 게시'], ['auto', '자동 게시']].map(([v, l]) => el('button', { type: 'button', 'aria-pressed': String(s.approval === v), onclick: () => { s.approval = v; draw(); } }, l)));
    box.append(el('div', { class: 'field' }, el('span', {}, '검수'), el('div', {}, seg), el('span', { class: 'muted', style: { fontSize: '12.5px' } }, '처음 2주는 승인 후 게시를 권합니다. 자동이면 역이 서자마자 예약됩니다.')));
    const angles = el('div', { class: 'angles' }, ...Object.entries(ANGLE_LABEL).map(([k, l]) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(s.angles.includes(k)), onclick: () => { s.angles = s.angles.includes(k) ? s.angles.filter((x) => x !== k) : [...s.angles, k]; if (!s.angles.length) s.angles = [k]; draw(); } }, l)));
    box.append(el('div', { class: 'field' }, el('span', {}, '쓰는 각도'), angles));
    const tone = el('textarea', { class: 'inp', placeholder: '말투 메모 — 예) 반말 금지, 이모지 없이, 숫자는 꼭 출처와', style: { minHeight: '70px' } }, s.tone || '');
    box.append(el('label', { class: 'field' }, el('span', {}, '말투'), tone));
    const save = el('button', { class: 'btn ink', type: 'button' }, '저장');
    save.addEventListener('click', async () => { s.tone = tone.value; try { await withBusy(save, () => api.settings(svc.id, s)); toast('저장했습니다'); closeModal(); await load(true); } catch (err) { toast(err.message, true); } });
    box.append(el('div', { class: 'acts' }, el('span', { class: 'spacer' }), save));
  };
  draw();
  openModal(box, { narrow: true });
}

function viewBriefEdit() {
  const svc = S.st.service;
  const name = el('input', { class: 'inp', value: svc.name, maxlength: 60 });
  const home = el('input', { class: 'inp', value: svc.homepage || '', placeholder: '홈페이지' });
  const brief = el('textarea', { class: 'inp', placeholder: '누구에게 무엇을, 어떻게 다른지 — 글을 쓸 때 바탕이 됩니다' }, svc.brief || '');
  const bio = el('textarea', { class: 'inp', maxlength: 150, placeholder: '계정 소개(150자)', style: { minHeight: '80px' } }, svc.bio || '');
  const save = el('button', { class: 'btn ink', type: 'button' }, '저장');
  save.addEventListener('click', async () => { try { await withBusy(save, () => api.brief(svc.id, { name: name.value, homepage: home.value, brief: brief.value, bio: bio.value })); toast('저장했습니다'); closeModal(); await load(true); } catch (err) { toast(err.message, true); } });
  return el('div', { class: 'settings' }, el('h2', {}, '서비스 설명'), el('label', { class: 'field' }, el('span', {}, '이름'), name), el('label', { class: 'field' }, el('span', {}, '홈페이지'), home), el('label', { class: 'field' }, el('span', {}, '설명'), brief), el('label', { class: 'field' }, el('span', {}, '소개'), bio), el('div', { class: 'acts' }, el('span', { class: 'spacer' }), save));
}

window.addEventListener('hashchange', () => { const q = new URLSearchParams(location.hash.replace(/^#\/?/, '')); if (q.get('s') && q.get('s') !== S.sid) { S.sid = q.get('s'); S.forceHome = false; load(); } });
