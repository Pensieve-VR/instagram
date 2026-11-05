// 자동 DM — 댓글·스토리 답장에 키워드가 오면 얼리버드 링크를 DM 으로(ManyChat·인포크 자동 DM 처럼). 공식 API 만.
//   댓글        → 비공개 답장(Private Replies: 댓글 하나에 DM 하나, 댓글 뒤 7일 안) + 공개 답글 한 줄
//   스토리 답장·DM → 그 사람에게 링크(상대가 먼저 보냈으니 24시간 안)
// 웹훅으로 바로 받고(Meta 가 보내 줄 때), 크론이 20초마다 한 번 더 본다(놓친 것·웹훅이 안 올 때).
// 같은 사람이 또 달면 또 보낸다(댓글마다 한 번). 댓글 뒤 7일이 지나면 Meta 가 비공개 답장을 받지 않는다.
import { db, event, J, metaGet, metaSet } from './db.js';
import { open } from './crypto.js';
import * as meta from './meta.js';
import { normalizeBrand, clip, DAY } from './plan.js';

const MIN = 60e3; const HOUR = 3600e3;
const WINDOW = { comment: 7 * DAY, message: 23 * HOUR };
const PAUSE = 30 * MIN; // 권한·토큰 문제 — 고칠 때까지 30분마다 한 번만 다시 본다
const MSG_PAUSE = HOUR; // 메시지 읽기가 안 되면 한 시간 쉰다(댓글은 계속)
const HOURLY_CAP = 200; // 한 계정 한 시간 — 자동 DM 도구들이 지키는 속도(넘으면 버리지 않고 다음 시간에)
const MAX_ATTEMPTS = 6;

export const DEFAULT_DM = {
  on: true,
  numbers: true, // 1~4 번호 댓글(컬러 고르기)에도
  messages: true, // 스토리 답장·DM 에도
  words: '링크, 얼리버드, link, early', // 브랜드 시트의 댓글 키워드(르네·RENE)는 늘 들어간다
  text: {
    ko: '안녕하세요, 르네예요 (자동 메시지)\n얼리버드 10% 대기 신청 링크예요 → {link}\n\n이메일만 남기면 끝. 출시 소식과 10% 코드는 메일로 보내드려요. 선착순이에요.\n궁금한 건 여기 물어보세요. 사람이 직접 답해요.',
    en: 'Hi, it’s René (automated message)\nHere’s your 10% early-bird link → {link}\n\nJust your email and you’re in. Launch news and your code come by email. Limited spots.\nQuestions? Ask right here — a human replies.',
  },
  replies: {
    ko: ['DM 확인해 주세요! 얼리버드 링크 보내드렸어요.', '보냈어요. DM함(요청함도)을 열어 보세요.', '르네가 DM으로 찾아갔어요.', '링크는 DM에 있어요. 고마워요!'],
    en: ['Check your DMs — the early-bird link is there!', 'Sent! Peek at your DMs (and requests).', 'René just slid into your DMs.', 'Link’s in your DMs. Thanks!'],
  },
};

// ---------- 순수 ----------
const LINK_RE = /\{link\}|\{링크\}/;
const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 200));
function textOf(v, fallback) {
  let t = String(v ?? '').trim();
  if (!t) t = fallback;
  t = t.slice(0, 900);
  if (!LINK_RE.test(t)) t = t.slice(0, 892) + '\n{link}'; // 링크 자리가 없으면 끝에 붙인다
  return t;
}
export function normalizeDm(s) {
  s = s && typeof s === 'object' ? s : {};
  const D = DEFAULT_DM; const tx = s.text || {}; const rp = s.replies || {};
  const flag = (v, d) => (v === undefined ? d : !!v);
  return {
    on: flag(s.on, D.on), numbers: flag(s.numbers, D.numbers), messages: flag(s.messages, D.messages),
    words: String(s.words ?? D.words).slice(0, 300),
    text: { ko: textOf(tx.ko, D.text.ko), en: textOf(tx.en, D.text.en) },
    replies: { ko: rp.ko === undefined ? D.replies.ko : lines(rp.ko), en: rp.en === undefined ? D.replies.en : lines(rp.en) },
  };
}

// 비교용 — 대소문자·악센트(rené = rene)를 같게
const norm = (t) => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export function matches(text, s, kw = {}) {
  const raw = String(text || '').normalize('NFC').trim();
  if (!raw) return false;
  const t = norm(raw);
  const words = [kw.ko, kw.en, ...String(s.words || '').split(/[,\n]/)].map((w) => String(w || '').trim()).filter((w) => w.length >= 2).map(norm);
  if (words.some((w) => t.includes(w))) return true;
  return !!s.numbers && raw.length <= 20 && /(^|[^0-9])[1-4](?![0-9])/.test(raw);
}

// 어느 글에서 왔나 → 대기 명단 출처(src). 콘솔 게시물이면 폴더 이름에서(P1·R2·고정 01), 아니면 미디어 ID 끝자리
export function slugOf(post, mediaId = '') {
  const src = String((post && post.src) || '');
  const seg = src.split('/').pop() || '';
  let s = '';
  const code = src.match(/(?:^|[_/])([prst]\d{1,2})(?=[_/]|$)/i);
  if (code) s = code[1];
  else if (/고정|pin/i.test(src)) s = 'pin' + ((seg.match(/^(\d{1,2})_/) || [])[1] || '');
  else if (post && post.id) s = 'x' + String(post.id).slice(-6);
  else s = 'm' + String(mediaId).slice(-6);
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'x';
}
export function linkFor(lang, slug, brandLink = 'https://www.pensieve.kr/early') {
  const code = `${lang === 'en' ? 'en_' : ''}ig_dm_${slug}`;
  let u;
  try { u = new URL(brandLink); } catch { u = new URL('https://www.pensieve.kr/early'); }
  if (/(^|\.)pensieve\.kr$/.test(u.hostname) && /^\/early\/?$/.test(u.pathname)) return `${u.origin}/r/${code}`; // 짧은 주소
  u.searchParams.set('src', code);
  return u.toString();
}
export const fill = (tpl, link) => String(tpl).replace(/\{link\}|\{링크\}/g, link);
const pick = (list, seed) => { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return list[h % list.length]; };

// Meta 오류 → transient(다음 틱에 다시) · perm(권한·토큰 — 멈추고 고칠 때까지) · item(이 댓글만 포기)
export function kindOf(e) {
  if (!(e instanceof meta.MetaError)) return 'transient';
  if (e.rateLimited || e.status >= 500 || e.code === 1 || e.code === 2) return 'transient';
  if (e.code === 10 && e.subcode === 2018278) return 'item'; // 보낼 수 있는 창이 지났다
  if (e.tokenProblem || e.code === 3 || (e.code >= 200 && e.code < 300) || /permission|not authorized|capability/i.test(e.message)) return 'perm';
  return 'item';
}
const errText = (e) => clip(String((e && e.message) || e), 240);

// ---------- 설정 · 상태 ----------
export async function getDm(env) { return normalizeDm(J(await metaGet(env, 'dm'), null)); }
export async function setDm(env, body = {}) {
  const prev = await getDm(env);
  const n = normalizeDm({ ...prev, ...body, text: { ...prev.text, ...(body.text || {}) }, replies: { ...prev.replies, ...(body.replies || {}) } });
  await metaSet(env, 'dm', JSON.stringify(n));
  if (!prev.on && n.on) { // 다시 켜면 그 뒤에 들어온 것부터 — 꺼져 있던 동안의 댓글엔 보내지 않는다
    const d = await db(env);
    await d.prepare("DELETE FROM r_meta WHERE k LIKE 'dm_state:%'").run();
  }
  if (prev.on !== n.on) await event(env, n.on ? 'dm.on' : 'dm.off', n.on ? '자동 DM 켬' : '자동 DM 끔');
  return n;
}
const stKey = (id) => 'dm_state:' + id;
async function getSt(env, id) {
  return { since: 0, cc: null, pausedUntil: 0, error: '', msgError: '', msgPausedUntil: 0, lastRun: 0, ...J(await metaGet(env, stKey(id)), {}) };
}
const putSt = (env, id, st) => metaSet(env, stKey(id), JSON.stringify(st));

// 기록 한 줄을 「보내는 중」으로 잡는다 — 잡은 쪽만 보낸다(겹친 크론이 두 번 보내지 않게). 다시 볼 것(retry)·멈춘 채 남은 것만 다시 잡힌다
async function claim(d, row, now) {
  const r = await d.prepare(`INSERT INTO r_dm (id,account_id,kind,user_id,username,media_id,post_id,text,link,state,attempts,created,at)
    VALUES (?,?,?,?,?,?,?,?,?,'sending',1,?,?)
    ON CONFLICT(id) DO UPDATE SET state='sending', attempts=r_dm.attempts+1, at=excluded.at
    WHERE (r_dm.state='retry' AND r_dm.attempts<?) OR (r_dm.state='sending' AND r_dm.at<?)`)
    .bind(row.id, row.account_id, row.kind, row.user_id, row.username, row.media_id || '', row.post_id || '', clip(row.text, 300), row.link, now, now, MAX_ATTEMPTS, now - 10 * MIN).run();
  return !!(r.meta && r.meta.changes);
}
async function setRow(d, id, f) {
  const keys = Object.keys(f);
  await d.prepare(`UPDATE r_dm SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).bind(...keys.map((k) => f[k]), id).run();
}

// ---------- 한 건 보내기 — 크론(20초마다)과 웹훅(바로)이 같이 쓴다 ----------
// 반환: 'ok'(끝 — 보냈거나 대상 아님) · 'later'(한도·잠깐 오류 — 다음에 다시) · 'stop'(권한·토큰 — 멈춤)
const isOwn = (acc, uid, uname) => (uid && uid === acc.igId) || (uname && acc.username && uname.toLowerCase() === acc.username.toLowerCase());
const refund = (d, id, e, now) => d.prepare("UPDATE r_dm SET state='retry', attempts=MAX(0, attempts-1), error=?, at=? WHERE id=?").bind(errText(e), now, id).run();

async function sendComment(env, d, X, c, mediaId) {
  const { acc, s, brand, now, box, call, out, st } = X;
  if (c.ts && c.ts < now - WINDOW.comment) return 'ok'; // 댓글 뒤 7일이 지나면 Meta 가 비공개 답장을 받지 않는다
  const from = c.from || {};
  const uid = String(from.id || ''); const uname = String(from.username || c.username || '');
  if (isOwn(acc, uid, uname) || !matches(c.text, s, brand.kw)) return 'ok';
  const replies = s.replies[acc.lang] || [];
  if (box.left < 1 + (replies.length ? 1 : 0)) return 'later';
  if (X.hour >= HOURLY_CAP) { st.error = `한 시간 ${HOURLY_CAP}개를 채워 나머지는 다음 시간에 보내요`; X.dirty = true; return 'later'; }
  if (!(mediaId in X.posts)) X.posts[mediaId] = mediaId ? await d.prepare('SELECT id, src FROM r_posts WHERE platform_post_id=? LIMIT 1').bind(mediaId).first() : null;
  const post = X.posts[mediaId];
  const link = linkFor(acc.lang, slugOf(post, mediaId), brand.link);
  const id = 'c:' + c.id;
  if (!(await claim(d, { id, account_id: acc.id, kind: 'comment', user_id: uid, username: uname, media_id: mediaId, post_id: post ? post.id : '', text: c.text, link }, now))) return 'ok';
  try { await call(() => meta.igSend(env, acc.igId, acc.token, { comment_id: c.id }, fill(s.text[acc.lang], link))); }
  catch (e) {
    const k = kindOf(e);
    if (k === 'perm') { await refund(d, id, e, now); await X.pause(e); return 'stop'; }
    await setRow(d, id, { state: k === 'transient' ? 'retry' : 'fail', error: errText(e), at: now });
    if (k !== 'transient') { out.failed++; return 'ok'; }
    return 'later';
  }
  await setRow(d, id, { state: 'sent', error: '', at: now }); out.sent++; X.hour++;
  if (replies.length && box.left >= 1) {
    try { await call(() => meta.igReplyComment(env, c.id, acc.token, pick(replies, c.id))); }
    catch (e) { await setRow(d, id, { error: '공개 답글 실패 — ' + errText(e) }); }
  }
  return 'ok';
}

// 스토리 답장·DM — 상대가 먼저 보냈으니 24시간 안에 답할 수 있다. DM 의 숫자는 키워드가 아니다
async function sendMessage(env, d, X, m) {
  const { acc, s, brand, now, box, call, out, st } = X;
  if (m.ts && m.ts < now - WINDOW.message) return 'ok';
  if (!m.uid || m.echo || isOwn(acc, m.uid, m.uname) || /pensieve\.kr\/r\//.test(m.text || '') || !matches(m.text, { ...s, numbers: false }, brand.kw)) return 'ok';
  if (box.left < 1) return 'later';
  if (X.hour >= HOURLY_CAP) return 'later';
  const link = linkFor(acc.lang, 'msg', brand.link);
  const id = 'm:' + m.id;
  if (!(await claim(d, { id, account_id: acc.id, kind: 'message', user_id: m.uid, username: m.uname || '', text: m.text, link }, now))) return 'ok';
  try { await call(() => meta.igSend(env, acc.igId, acc.token, { id: m.uid }, fill(s.text[acc.lang], link))); }
  catch (e) {
    const k = kindOf(e);
    if (k === 'perm') { await refund(d, id, e, now); st.msgError = errText(e); st.msgPausedUntil = now + MSG_PAUSE; X.dirty = true; return 'stop'; }
    await setRow(d, id, { state: k === 'transient' ? 'retry' : 'fail', error: errText(e), at: now });
    if (k !== 'transient') out.failed++;
    return k === 'transient' ? 'later' : 'ok';
  }
  await setRow(d, id, { state: 'sent', error: '', at: now }); out.sent++; X.hour++;
  return 'ok';
}

async function linkedIg(env, d) {
  const { results } = await d.prepare("SELECT * FROM r_accounts WHERE platform='ig' AND status='linked' AND token_enc<>'' AND platform_id<>'' ORDER BY sort, created").all();
  return results;
}
async function prep(env, d, r, { s, brand, now, box, call, out }) {
  const acc = { id: r.id, igId: String(r.platform_id), username: String(r.username || ''), lang: r.lang === 'en' ? 'en' : 'ko', token: await open(env, r.token_enc) };
  const st = await getSt(env, acc.id);
  const h = await d.prepare("SELECT COUNT(*) AS n FROM r_dm WHERE account_id=? AND state='sent' AND at>?").bind(acc.id, now - HOUR).first();
  const X = { acc, s, brand, now, box, call, out, st, hour: h.n || 0, posts: {}, dirty: false };
  X.pause = async (e) => {
    const was = st.pausedUntil > 0 && st.error;
    st.error = errText(e); st.pausedUntil = now + PAUSE; X.dirty = true;
    if (!was) await event(env, 'dm.paused', `@${acc.username} 자동 DM 멈춤 — ${st.error}`, 'warn');
  };
  return X;
}

// ---------- 크론(20초마다 한 번씩 불린다) ----------
export async function runDm(env, { now = Date.now(), budget = 40, messages = true } = {}) {
  const out = { sent: 0, failed: 0, calls: 0 };
  const s = await getDm(env);
  if (!s.on) return out;
  const brand = normalizeBrand(J(await metaGet(env, 'brand'), null));
  const d = await db(env);
  const box = { left: budget };
  const call = (fn) => { box.left--; out.calls++; return fn(); };
  for (const r of await linkedIg(env, d)) {
    if (box.left < 2) break;
    try {
      const X = await prep(env, d, r, { s, brand, now, box, call, out });
      await runAccount(env, d, X, messages);
    } catch (e) { console.error('dm', e && e.stack || e); }
  }
  return out;
}

async function runAccount(env, d, X, withMessages) {
  const { acc, s, now, box, call, st } = X;
  const save = () => putSt(env, acc.id, { ...st, lastRun: now });
  if (st.pausedUntil > now) return;

  let list;
  try { list = await call(() => meta.igMediaCounts(env, acc.igId, acc.token)); st.error = ''; st.pausedUntil = 0; }
  catch (e) {
    if (kindOf(e) === 'perm') await X.pause(e);
    else if (e instanceof meta.MetaError && e.rateLimited) { st.error = 'Instagram 호출 한도 — 5분 쉬어요'; st.pausedUntil = now + 5 * MIN; }
    else st.error = errText(e);
    return save();
  }

  // 1) 댓글 — 댓글 수가 바뀐 게시물만 읽는다(처음이면 모두: 지난 7일 안 댓글까지 보낸다)
  const cc = st.cc || {};
  const next = Object.fromEntries(list.map((m) => [m.id, cc[m.id] ?? 0]));
  let stop = false;
  for (const m of list) {
    if (stop) break;
    if (m.comments === next[m.id]) continue;
    if (!m.comments) { next[m.id] = 0; continue; }
    if (box.left < 2) break;
    let comments;
    try { comments = await call(() => meta.igComments(env, m.id, acc.token)); }
    catch (e) { if (kindOf(e) === 'perm') { await X.pause(e); stop = true; } continue; }
    let done = true;
    for (const c of comments.map((x) => ({ ...x, ts: Date.parse(x.timestamp) || 0 })).sort((a, b) => a.ts - b.ts)) {
      const r = await sendComment(env, d, X, c, m.id);
      if (r === 'stop') { stop = true; done = false; break; }
      if (r === 'later') done = false;
    }
    if (done) next[m.id] = m.comments;
  }
  st.cc = next;

  // 2) 스토리 답장·DM
  if (withMessages && !stop && s.messages && !(st.msgPausedUntil > now) && box.left >= 2) {
    let convs = null;
    try { convs = await call(() => meta.igConversations(env, acc.igId, acc.token)); st.msgError = ''; }
    catch (e) { st.msgError = errText(e); if (kindOf(e) !== 'transient') st.msgPausedUntil = now + MSG_PAUSE; }
    outer: for (const cv of convs || []) {
      const msgs = ((cv.messages && cv.messages.data) || []).map((mg) => ({ id: mg.id, text: mg.message || '', uid: String((mg.from && mg.from.id) || ''), uname: String((mg.from && mg.from.username) || ''), ts: Date.parse(mg.created_time) || 0 }));
      for (const mg of msgs.sort((a, b) => a.ts - b.ts)) {
        const r = await sendMessage(env, d, X, mg);
        if (r === 'stop' || (r === 'later' && box.left < 1)) break outer;
      }
    }
  }
  return save();
}

// ---------- 웹훅(Meta 가 바로 알려 준다) ----------
// 콜백 주소: /api/meta/ig/webhook · 확인 토큰은 SESSION_SECRET 에서 만든다(따로 정할 비밀 없음)
async function hmac(key, text, enc = 'hex') {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  if (enc === 'hex') return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hookToken(env) { return env.SESSION_SECRET ? 'rene-' + (await hmac(env.SESSION_SECRET, 'ig-webhook-verify', 'b64')).slice(0, 24) : ''; }
export async function hookVerify(env, url) {
  const q = url.searchParams;
  const tk = await hookToken(env);
  return q.get('hub.mode') === 'subscribe' && tk && q.get('hub.verify_token') === tk ? String(q.get('hub.challenge') || '') : null;
}
// X-Hub-Signature-256 = sha256=HMAC(본문, 앱 시크릿) — 같은 길이 비교
export async function hookSignatureOk(env, raw, header) {
  const secret = meta.appCreds(env, 'ig').secret;
  const got = String(header || '').replace(/^sha256=/, '');
  if (!secret || !/^[0-9a-f]{64}$/.test(got)) return false;
  const want = await hmac(secret, raw);
  let diff = 0; for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
export async function handleHook(env, payload, now = Date.now()) {
  const out = { sent: 0, failed: 0, calls: 0 };
  if (!payload || payload.object !== 'instagram') return out;
  await metaSet(env, 'dm_hook_at', String(now));
  const s = await getDm(env);
  if (!s.on) return out;
  const brand = normalizeBrand(J(await metaGet(env, 'brand'), null));
  const d = await db(env);
  const rows = await linkedIg(env, d);
  const box = { left: 40 };
  const call = (fn) => { box.left--; out.calls++; return fn(); };
  for (const en of payload.entry || []) {
    const ids = [String(en.id || ''), ...(en.messaging || []).map((ev) => String((ev.recipient && ev.recipient.id) || ''))];
    const r = rows.find((x) => ids.includes(String(x.platform_id))) || (rows.length === 1 ? rows[0] : null);
    if (!r) continue;
    const X = await prep(env, d, r, { s, brand, now, box, call, out });
    if (X.st.pausedUntil > now) continue; // 멈춘 동안은 크론이 나중에 다시 본다
    for (const ch of en.changes || []) {
      const v = ch && ch.value;
      if (ch.field !== 'comments' || !v || !v.id) continue;
      const r1 = await sendComment(env, d, X, { id: String(v.id), text: v.text || '', from: v.from || {}, ts: Number(en.time) > 0 ? Number(en.time) * 1000 : now }, String((v.media && v.media.id) || ''));
      if (r1 === 'stop') break;
    }
    if (s.messages && !(X.st.msgPausedUntil > now)) {
      for (const ev of en.messaging || []) {
        const m = ev && ev.message;
        if (!m || !m.mid || !m.text) continue;
        const r2 = await sendMessage(env, d, X, { id: String(m.mid), text: String(m.text), uid: String((ev.sender && ev.sender.id) || ''), uname: '', echo: !!m.is_echo, ts: Number(ev.timestamp) || now });
        if (r2 === 'stop') break;
      }
    }
    if (X.dirty) await putSt(env, X.acc.id, X.st);
  }
  return out;
}
// 이 계정의 댓글·메시지를 이 앱으로 보내 달라고 Meta 에 한 번 알린다
export async function hookSubscribe(env) {
  const d = await db(env);
  const out = [];
  for (const r of await linkedIg(env, d)) {
    try { await meta.igSubscribe(env, r.platform_id, await open(env, r.token_enc), 'comments,messages'); out.push({ id: r.id, username: r.username, ok: true }); }
    catch (e) { out.push({ id: r.id, username: r.username, ok: false, error: errText(e) }); }
  }
  await event(env, 'dm.subscribe', out.map((x) => `@${x.username} ${x.ok ? '연결' : '실패 — ' + x.error}`).join(' · ') || 'IG 줄 없음', out.every((x) => x.ok) ? 'info' : 'warn');
  return out;
}

// ---------- 화면용 ----------
export async function dmOverview(env, now = Date.now(), origin = '') {
  const d = await db(env);
  const settings = await getDm(env);
  const { results: accs } = await d.prepare("SELECT id, username, lang FROM r_accounts WHERE platform='ig' AND status='linked' AND platform_id<>'' ORDER BY sort, created").all();
  const accounts = [];
  for (const a of accs) {
    const st = await getSt(env, a.id);
    accounts.push({ id: a.id, username: a.username, lang: a.lang, lastRun: st.lastRun, error: st.error, pausedUntil: st.pausedUntil, msgError: st.msgError, msgPausedUntil: st.msgPausedUntil });
  }
  const c = await d.prepare("SELECT SUM(state='sent') AS sent, SUM(state='sent' AND at>?) AS today, SUM(state='fail') AS failed FROM r_dm").bind(now - DAY).first();
  const { results: recent } = await d.prepare('SELECT id, account_id, kind, username, text, link, state, error, at FROM r_dm ORDER BY at DESC LIMIT 40').all();
  const hook = { url: `${String(origin || env.PUBLIC_ORIGIN || '').replace(/\/$/, '')}/api/meta/ig/webhook`, verifyToken: await hookToken(env), lastAt: Number(await metaGet(env, 'dm_hook_at')) || 0 };
  return { settings, accounts, counts: { sent: c.sent || 0, today: c.today || 0, failed: c.failed || 0 }, recent, hook };
}
// 권한 점검 — 토큰에 자동 DM 권한이 다 있나(앱 시크릿으로 debug_token)
export async function dmCheck(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM r_accounts WHERE platform='ig' AND status='linked' AND token_enc<>'' AND platform_id<>'' ORDER BY sort, created").all();
  const out = [];
  for (const r of results) {
    try {
      const token = await open(env, r.token_enc);
      const x = await meta.tokenScopes(env, token);
      let hookFields = null;
      try { hookFields = await meta.igSubscribed(env, r.platform_id, token); } catch { hookFields = null; }
      out.push({ id: r.id, username: r.username, scopes: x.scopes, missing: meta.DM_SCOPES.filter((p) => !x.scopes.includes(p)), valid: x.valid, hookFields });
    } catch (e) { out.push({ id: r.id, username: r.username, error: errText(e) }); }
  }
  return out;
}
// 하루 한 번 — 30일 지난 기록의 글은 지운다(누구에게 보냈는지는 중복 막기에 남긴다)
export async function dmCleanup(env, now = Date.now()) {
  const d = await db(env);
  const r = await d.prepare("UPDATE r_dm SET text='' WHERE at<? AND text<>''").bind(now - 30 * DAY).run();
  return (r.meta && r.meta.changes) || 0;
}
