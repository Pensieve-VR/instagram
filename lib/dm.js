// 자동 DM — 댓글·스토리 답장에 키워드가 오면 얼리버드 링크를 DM 으로(ManyChat·인포크 자동 DM 처럼). 공식 API 만.
//   댓글        → 비공개 답장(Private Replies: 댓글 하나에 DM 하나, 댓글 뒤 7일 안) + 공개 답글 한 줄
//   스토리 답장·DM → 그 사람에게 링크(상대가 먼저 보냈으니 24시간 안)
// 웹훅 없이 크론(1분)이 본다 — 게시물 댓글 수가 바뀐 것만 댓글을 읽는다. 켠 뒤에 들어온 것만, 한 사람에게 한 번.
import { db, event, J, metaGet, metaSet } from './db.js';
import { open } from './crypto.js';
import * as meta from './meta.js';
import { normalizeBrand, clip, DAY } from './plan.js';

const MIN = 60e3; const HOUR = 3600e3;
const WINDOW = { comment: 7 * DAY, message: 23 * HOUR };
const PAUSE = 30 * MIN; // 권한·토큰 문제 — 고칠 때까지 30분마다 한 번만 다시 본다
const MSG_PAUSE = HOUR; // 메시지 읽기가 안 되면 한 시간 쉰다(댓글은 계속)
const HOURLY_CAP = 150; // 한 계정 한 시간 — Instagram 자동 DM 한도(시간당 200) 안쪽
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

// ---------- 크론 ----------
export async function runDm(env, { now = Date.now(), budget = 40 } = {}) {
  const out = { sent: 0, dup: 0, failed: 0, calls: 0 };
  const s = await getDm(env);
  if (!s.on) return out;
  const brand = normalizeBrand(J(await metaGet(env, 'brand'), null));
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM r_accounts WHERE platform='ig' AND status='linked' AND token_enc<>'' AND platform_id<>'' ORDER BY sort, created").all();
  const box = { left: budget };
  const call = (fn) => { box.left--; out.calls++; return fn(); };
  for (const r of results) {
    if (box.left < 2) break;
    const acc = { id: r.id, igId: String(r.platform_id), username: String(r.username || ''), lang: r.lang === 'en' ? 'en' : 'ko', token: await open(env, r.token_enc) };
    try { await runAccount(env, d, { acc, s, brand, now, box, call, out }); } catch (e) { console.error('dm', e && e.stack || e); }
  }
  return out;
}

const isOwn = (acc, uid, uname) => (uid && uid === acc.igId) || (uname && acc.username && uname.toLowerCase() === acc.username.toLowerCase());

async function runAccount(env, d, { acc, s, brand, now, box, call, out }) {
  const st = await getSt(env, acc.id);
  const save = () => putSt(env, acc.id, { ...st, lastRun: now });
  if (st.pausedUntil > now) return;
  const pause = async (e) => {
    const was = st.pausedUntil > 0 && st.error;
    st.error = errText(e); st.pausedUntil = now + PAUSE;
    if (!was) await event(env, 'dm.paused', `@${acc.username} 자동 DM 멈춤 — ${st.error}`, 'warn');
  };

  // 기준 잡기(처음 켰을 때) — 지금 댓글 수만 적고 보내지 않는다
  let list;
  try { list = await call(() => meta.igMediaCounts(env, acc.igId, acc.token)); st.error = ''; st.pausedUntil = 0; }
  catch (e) { if (kindOf(e) === 'perm') await pause(e); else st.error = errText(e); return save(); }
  if (!st.since) { st.since = now; st.cc = Object.fromEntries(list.map((m) => [m.id, m.comments])); return save(); }

  const sentHour = await d.prepare("SELECT COUNT(*) AS n FROM r_dm WHERE account_id=? AND state='sent' AND at>?").bind(acc.id, now - HOUR).first();
  if (sentHour.n >= HOURLY_CAP) { st.error = `한 시간에 ${HOURLY_CAP}개를 보내 잠시 쉬어요`; return save(); }

  const kw = brand.kw;
  const text = s.text[acc.lang];
  const replies = s.replies[acc.lang] || [];
  const need = 1 + (replies.length ? 1 : 0);
  const cc = st.cc || {};
  const next = Object.fromEntries(list.map((m) => [m.id, cc[m.id] ?? 0])); // 처음 보는 게시물은 0 에서
  let stop = false;

  // 1) 댓글
  for (const m of list) {
    if (stop) break;
    if (m.comments === next[m.id]) continue;
    if (!m.comments) { next[m.id] = 0; continue; }
    if (box.left < 1 + need) break;
    let comments;
    try { comments = await call(() => meta.igComments(env, m.id, acc.token)); }
    catch (e) { if (kindOf(e) === 'perm') { await pause(e); stop = true; } continue; }
    const post = await d.prepare('SELECT id, src FROM r_posts WHERE platform_post_id=? LIMIT 1').bind(m.id).first();
    const link = linkFor(acc.lang, slugOf(post, m.id), brand.link);
    let done = true;
    for (const c of comments.slice().sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))) {
      const ts = Date.parse(c.timestamp) || 0;
      if (ts < Math.max(st.since, now - WINDOW.comment)) continue;
      const from = c.from || {};
      const uid = String(from.id || ''); const uname = String(from.username || c.username || '');
      if (isOwn(acc, uid, uname) || !matches(c.text, s, kw)) continue;
      if (box.left < need) { done = false; break; }
      const id = 'c:' + c.id;
      if (!(await claim(d, { id, account_id: acc.id, kind: 'comment', user_id: uid, username: uname, media_id: m.id, post_id: post ? post.id : '', text: c.text, link }, now))) continue;
      if (uid) {
        const dup = await d.prepare("SELECT 1 AS x FROM r_dm WHERE account_id=? AND user_id=? AND state='sent' LIMIT 1").bind(acc.id, uid).first();
        if (dup) { await setRow(d, id, { state: 'dup', at: now }); out.dup++; continue; }
      }
      try { await call(() => meta.igSend(env, acc.igId, acc.token, { comment_id: c.id }, fill(text, link))); }
      catch (e) {
        const k = kindOf(e);
        if (k === 'perm') { await d.prepare("UPDATE r_dm SET state='retry', attempts=MAX(0, attempts-1), error=?, at=? WHERE id=?").bind(errText(e), now, id).run(); await pause(e); stop = true; done = false; break; }
        if (k === 'transient') { await setRow(d, id, { state: 'retry', error: errText(e), at: now }); done = false; continue; }
        await setRow(d, id, { state: 'fail', error: errText(e), at: now }); out.failed++; continue;
      }
      await setRow(d, id, { state: 'sent', error: '', at: now }); out.sent++;
      if (replies.length && box.left >= 1) {
        try { await call(() => meta.igReplyComment(env, c.id, acc.token, pick(replies, c.id))); }
        catch (e) { await setRow(d, id, { error: '공개 답글 실패 — ' + errText(e) }); }
      }
    }
    if (done) next[m.id] = m.comments;
  }
  st.cc = next;

  // 2) 스토리 답장·DM
  if (!stop && s.messages && !(st.msgPausedUntil > now) && box.left >= 2) {
    let convs = null;
    try { convs = await call(() => meta.igConversations(env, acc.igId, acc.token)); st.msgError = ''; }
    catch (e) { st.msgError = errText(e); if (kindOf(e) !== 'transient') st.msgPausedUntil = now + MSG_PAUSE; }
    const link = linkFor(acc.lang, 'msg', brand.link);
    const sm = { ...s, numbers: false }; // DM 의 숫자는 키워드가 아니다(대화 중 「2」 같은 답에 링크가 가지 않게)
    outer: for (const cv of convs || []) {
      const msgs = ((cv.messages && cv.messages.data) || []).slice().sort((a, b) => (Date.parse(a.created_time) || 0) - (Date.parse(b.created_time) || 0));
      for (const mg of msgs) {
        const ts = Date.parse(mg.created_time) || 0;
        if (ts < Math.max(st.since, now - WINDOW.message)) continue;
        const from = mg.from || {};
        const uid = String(from.id || ''); const uname = String(from.username || '');
        if (!uid || isOwn(acc, uid, uname) || /pensieve\.kr\/r\//.test(mg.message || '') || !matches(mg.message, sm, kw)) continue;
        if (box.left < 1) break outer;
        const id = 'm:' + mg.id;
        if (!(await claim(d, { id, account_id: acc.id, kind: 'message', user_id: uid, username: uname, text: mg.message, link }, now))) continue;
        try { await call(() => meta.igSend(env, acc.igId, acc.token, { id: uid }, fill(text, link))); }
        catch (e) {
          const k = kindOf(e);
          if (k === 'perm') { await d.prepare("UPDATE r_dm SET state='retry', attempts=MAX(0, attempts-1), error=?, at=? WHERE id=?").bind(errText(e), now, id).run(); st.msgError = errText(e); st.msgPausedUntil = now + MSG_PAUSE; break outer; }
          await setRow(d, id, { state: k === 'transient' ? 'retry' : 'fail', error: errText(e), at: now }); if (k !== 'transient') out.failed++;
          continue;
        }
        await setRow(d, id, { state: 'sent', error: '', at: now }); out.sent++;
      }
    }
  }
  return save();
}

// ---------- 화면용 ----------
export async function dmOverview(env, now = Date.now()) {
  const d = await db(env);
  const settings = await getDm(env);
  const { results: accs } = await d.prepare("SELECT id, username, lang FROM r_accounts WHERE platform='ig' AND status='linked' AND platform_id<>'' ORDER BY sort, created").all();
  const accounts = [];
  for (const a of accs) {
    const st = await getSt(env, a.id);
    accounts.push({ id: a.id, username: a.username, lang: a.lang, since: st.since, lastRun: st.lastRun, error: st.error, pausedUntil: st.pausedUntil, msgError: st.msgError, msgPausedUntil: st.msgPausedUntil });
  }
  const c = await d.prepare("SELECT SUM(state='sent') AS sent, SUM(state='sent' AND at>?) AS today, SUM(state='fail') AS failed, SUM(state='dup') AS dup FROM r_dm").bind(now - DAY).first();
  const { results: recent } = await d.prepare('SELECT id, account_id, kind, username, text, link, state, error, at FROM r_dm ORDER BY at DESC LIMIT 40').all();
  return { settings, accounts, counts: { sent: c.sent || 0, today: c.today || 0, failed: c.failed || 0, dup: c.dup || 0 }, recent };
}
// 권한 점검 — 토큰에 자동 DM 권한이 다 있나(앱 시크릿으로 debug_token)
export async function dmCheck(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM r_accounts WHERE platform='ig' AND status='linked' AND token_enc<>'' AND platform_id<>'' ORDER BY sort, created").all();
  const out = [];
  for (const r of results) {
    try {
      const x = await meta.tokenScopes(env, await open(env, r.token_enc));
      out.push({ id: r.id, username: r.username, scopes: x.scopes, missing: meta.DM_SCOPES.filter((p) => !x.scopes.includes(p)), valid: x.valid });
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
