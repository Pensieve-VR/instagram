// 운영 동작 — API 와 크론이 같이 쓴다. 줄(계정)·소재·게시물·만들기(Claude)·게시·지표.
import { db, event, J, rowAccount, rowPost, newId, metaGet, metaSet } from './db.js';
import { ask } from './ai.js';
import { makePrompt, revisePrompt, CARD_KINDS } from './prompts.js';
import * as meta from './meta.js';
import { seal, open } from './crypto.js';
import { cardHtml, renderMany, renderReady } from './render.js';
import { putMedia, deleteMedia, deletePrefix, mediaReady } from './media.js';
import { FORMATS, LIMITS, problems, transition, suggestTimes, composeCaption, clip, cleanTags, normalizeBrand, DAY, isDue, PLATFORM_NAME } from './plan.js';
import { step } from './publish.js';

const nowMs = () => Date.now();
const fail = (status, error, detail) => Object.assign(new Error(error), { status, detail });
export const mediaUrl = (origin, key) => `${String(origin).replace(/\/$/, '')}/media/${key}`;
const originOf = (env, origin) => origin || String(env.PUBLIC_ORIGIN || '').replace(/\/$/, '');

// ---------- 줄(계정) ----------
export async function listAccounts(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM r_accounts ORDER BY sort, created').all();
  return results.map(rowAccount);
}
export async function getAccount(env, id) {
  const d = await db(env);
  return rowAccount(await d.prepare('SELECT * FROM r_accounts WHERE id=?').bind(id).first());
}
async function accountWithToken(env, id) {
  const d = await db(env);
  const r = await d.prepare('SELECT * FROM r_accounts WHERE id=?').bind(id).first();
  if (!r) return null;
  return { ...rowAccount(r), token: r.token_enc ? await open(env, r.token_enc) : '' };
}
export async function addLine(env, { platform, lang }) {
  if (!FORMATS[platform] || !['ko', 'en'].includes(lang)) throw fail(400, 'bad_line');
  const d = await db(env); const t = nowMs();
  const max = await d.prepare('SELECT COALESCE(MAX(sort), -1) AS s FROM r_accounts').first();
  const id = newId('a');
  await d.prepare('INSERT INTO r_accounts (id,platform,lang,status,sort,created,updated) VALUES (?,?,?,?,?,?,?)').bind(id, platform, lang, 'planned', (max.s || 0) + 1, t, t).run();
  await event(env, 'line.added', `${PLATFORM_NAME[platform]} ${lang.toUpperCase()}`);
  return getAccount(env, id);
}
export async function patchAccount(env, id, body) {
  const a = await getAccount(env, id); if (!a) throw fail(404, 'not_found');
  const d = await db(env);
  const sets = []; const vals = [];
  if (body.slot != null) { const s = String(body.slot); if (s && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw fail(400, 'bad_slot'); sets.push('slot=?'); vals.push(s); }
  if (body.lang != null) { if (!['ko', 'en'].includes(body.lang)) throw fail(400, 'bad_lang'); sets.push('lang=?'); vals.push(body.lang); }
  if (body.sort != null) { sets.push('sort=?'); vals.push(Number(body.sort) || 0); }
  if (!sets.length) return a;
  await d.prepare(`UPDATE r_accounts SET ${sets.join(', ')}, updated=? WHERE id=?`).bind(...vals, nowMs(), id).run();
  return getAccount(env, id);
}
// 연결 끊기 — 줄은 점선으로 남고, 그 줄의 게시물도 남는다
export async function unlinkAccount(env, id) {
  const d = await db(env);
  await d.prepare("UPDATE r_accounts SET token_enc='', token_exp=0, status='planned', platform_id='', updated=? WHERE id=?").bind(nowMs(), id).run();
  await event(env, 'line.unlinked', id, 'warn');
}
// 줄 지우기 — 올라간 적 없는 게시물만 있으면 같이 지운다. 올라간 게시물이 있으면 막는다(기록 보존).
export async function removeLine(env, id) {
  const d = await db(env);
  const posted = await d.prepare("SELECT COUNT(*) AS n FROM r_posts WHERE account_id=? AND state IN ('posted','publishing')").bind(id).first();
  if (posted.n) throw fail(409, 'has_posted');
  await d.batch([d.prepare('DELETE FROM r_posts WHERE account_id=?').bind(id), d.prepare('DELETE FROM r_accounts WHERE id=?').bind(id)]);
}

// OAuth 로 받은 토큰을 줄에 붙인다. 같은 계정이 이미 다른 줄에 있으면 그 줄을 갱신하고 이 줄의 게시물을 옮긴다.
export async function saveLink(env, accountId, kind, { token, expiresAt, profile }) {
  const d = await db(env); const t = nowMs();
  const enc = await seal(env, token);
  const target = await d.prepare('SELECT * FROM r_accounts WHERE id=?').bind(accountId).first();
  const same = await d.prepare('SELECT id FROM r_accounts WHERE platform=? AND platform_id=?').bind(kind, String(profile.id)).first();
  const id = same ? same.id : accountId;
  await d.prepare('UPDATE r_accounts SET platform=?, platform_id=?, username=?, name=?, picture=?, token_enc=?, token_exp=?, status=?, updated=? WHERE id=?')
    .bind(kind, String(profile.id), profile.username || '', profile.name || '', profile.picture || '', enc, expiresAt || 0, 'linked', t, id).run();
  if (same && target && same.id !== accountId && target.status !== 'linked') {
    await d.batch([d.prepare('UPDATE r_posts SET account_id=? WHERE account_id=?').bind(same.id, accountId), d.prepare('DELETE FROM r_accounts WHERE id=?').bind(accountId)]);
  }
  await event(env, 'line.linked', `${meta.kindName(kind)} @${profile.username}`);
  return id;
}
// Instagram — 이미 연결된 Instagram 토큰(시스템 사용자)이 다룰 수 있는 계정들. 포트폴리오에 넣은 새 계정이 여기 뜬다.
async function anyIgToken(env) {
  const d = await db(env);
  const r = await d.prepare("SELECT token_enc FROM r_accounts WHERE platform='ig' AND status='linked' AND token_enc<>'' ORDER BY updated DESC LIMIT 1").first();
  return r ? { enc: r.token_enc, token: await open(env, r.token_enc) } : null;
}
export async function availableIg(env) {
  const tk = await anyIgToken(env);
  if (!tk) return { accounts: [], needLogin: true };
  const list = await meta.igAccounts(env, tk.token);
  const d = await db(env);
  const { results } = await d.prepare("SELECT id, platform_id FROM r_accounts WHERE platform='ig' AND platform_id<>''").all();
  const used = new Map(results.map((r) => [r.platform_id, r.id]));
  return { accounts: list.map((a) => ({ ...a, line: used.get(a.id) || '' })), needLogin: false };
}
export async function attachIg(env, accountId, igId) {
  const tk = await anyIgToken(env); if (!tk) throw fail(409, 'no_ig_token');
  const list = await meta.igAccounts(env, tk.token);
  if (!list.some((a) => a.id === String(igId))) throw fail(404, 'not_assigned');
  const profile = await meta.me(env, 'ig', tk.token, String(igId));
  return saveLink(env, accountId, 'ig', { token: tk.token, expiresAt: 0, profile });
}
// Meta 앱 해제·데이터 삭제 요청 — 그 계정의 토큰을 지운다
export async function forgetAccount(env, kind, platformId, what) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT id FROM r_accounts WHERE platform=? AND platform_id=?').bind(kind, String(platformId)).all();
  for (const r of results) {
    if (what === 'delete') await d.prepare("UPDATE r_accounts SET token_enc='', token_exp=0, picture='', name='', status='expired', updated=? WHERE id=?").bind(nowMs(), r.id).run();
    else await d.prepare("UPDATE r_accounts SET token_enc='', token_exp=0, status='expired', updated=? WHERE id=?").bind(nowMs(), r.id).run();
    await event(env, what === 'delete' ? 'line.deleted' : 'line.uninstalled', `${meta.kindName(kind)} — 다시 연결`, 'bad');
  }
  return results.length;
}
async function markExpired(env, accountId, why) {
  const d = await db(env);
  await d.prepare("UPDATE r_accounts SET status='expired', updated=? WHERE id=?").bind(nowMs(), accountId).run();
  await event(env, 'line.expired', why, 'bad');
}
// Threads 60일 토큰 — 열흘 안에 끝나면 늘린다
export async function refreshTokens(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM r_accounts WHERE token_enc<>'' AND status='linked' AND token_exp > 0 AND token_exp < ?").bind(nowMs() + 10 * DAY).all();
  let n = 0;
  for (const a of results.filter((r) => meta.refreshable(r.platform))) {
    try {
      const r = await meta.refresh(env, a.platform, await open(env, a.token_enc));
      await d.prepare('UPDATE r_accounts SET token_enc=?, token_exp=?, updated=? WHERE id=?').bind(await seal(env, r.token), r.expiresAt, nowMs(), a.id).run();
      await event(env, 'token.refreshed', `${meta.kindName(a.platform)} @${a.username}`); n++;
    } catch (e) {
      if (e instanceof meta.MetaError && e.tokenProblem) await markExpired(env, a.id, e.message);
      else await event(env, 'token.refresh_failed', `${meta.kindName(a.platform)} — ${e.message}`, 'warn');
    }
  }
  return n;
}

// ---------- 브랜드 시트 ----------
export async function getBrand(env) { return normalizeBrand(J(await metaGet(env, 'brand'), null)); }
export async function setBrand(env, b) { const n = normalizeBrand(b); await metaSet(env, 'brand', JSON.stringify(n)); await event(env, 'brand.saved', `사실 ${n.facts.length}개`); return n; }

// ---------- 소재 ----------
export async function listAssets(env, limit = 400) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM r_assets ORDER BY created DESC LIMIT ?').bind(limit).all();
  return results;
}
export async function assetsByIds(env, ids) {
  const list = [...new Set((ids || []).filter((x) => /^f[a-z0-9]{6,24}$/.test(String(x))))];
  if (!list.length) return [];
  const d = await db(env);
  const { results } = await d.prepare(`SELECT * FROM r_assets WHERE id IN (${list.map(() => '?').join(',')})`).bind(...list).all();
  return results;
}
export async function findAsset(env, src, bytes) {
  if (!src) return null;
  const d = await db(env);
  return d.prepare('SELECT * FROM r_assets WHERE src=? AND bytes=? LIMIT 1').bind(src, bytes).first();
}
export async function addAsset(env, { bytes, mime, kind, w = 0, h = 0, title = '', src = '' }) {
  if (!mediaReady(env)) throw fail(503, 'no_media');
  const id = newId('f');
  const ext = mime === 'image/png' ? 'png' : mime === 'video/mp4' ? 'mp4' : mime === 'video/quicktime' ? 'mov' : 'jpg';
  const key = `a/${id}.${ext}`;
  await putMedia(env, key, bytes, mime);
  const d = await db(env);
  await d.prepare('INSERT INTO r_assets (id,key,kind,mime,bytes,w,h,title,src,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, key, kind, mime, bytes.byteLength, Number(w) || 0, Number(h) || 0, String(title).slice(0, 120), String(src).slice(0, 400), nowMs()).run();
  return d.prepare('SELECT * FROM r_assets WHERE id=?').bind(id).first();
}
// 소재 지우기 — 그 소재를 쓰던 미게시 글은 장을 빼고 「내 차례」로 돌린다(깨진 채 올라가지 않게)
export async function deleteAsset(env, id) {
  const d = await db(env);
  const a = await d.prepare('SELECT * FROM r_assets WHERE id=?').bind(id).first();
  if (!a) throw fail(404, 'not_found');
  const { results } = await d.prepare("SELECT id, media, cover FROM r_posts WHERE state IN ('review','scheduled','failed','skipped') AND (media LIKE ? OR cover=?)").bind(`%${id}%`, id).all();
  for (const r of results) {
    const media = J(r.media, []).filter((m) => m.asset !== id);
    await d.prepare("UPDATE r_posts SET media=?, cover=?, state=CASE WHEN state='skipped' THEN 'skipped' ELSE 'review' END, error=?, updated=? WHERE id=?")
      .bind(JSON.stringify(media), r.cover === id ? '' : r.cover, '소재가 지워져 장이 빠졌습니다', nowMs(), r.id).run();
  }
  await deleteMedia(env, a.key);
  await d.prepare('DELETE FROM r_assets WHERE id=?').bind(id).run();
  return { detached: results.length };
}

// ---------- 게시물 ----------
export async function getPost(env, id) {
  const d = await db(env);
  return rowPost(await d.prepare('SELECT * FROM r_posts WHERE id=?').bind(id).first());
}
export async function postsIn(env, from, to) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM r_posts WHERE scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at').bind(from, to).all();
  return results.map(rowPost);
}
export async function waiting(env) {
  const d = await db(env);
  const r = await d.prepare("SELECT COUNT(*) AS n, MIN(scheduled_at) AS next FROM r_posts WHERE state='review'").first();
  const f = await d.prepare("SELECT COUNT(*) AS n FROM r_posts WHERE state='failed'").first();
  return { review: r.n || 0, next: r.next || 0, failed: f.n || 0 };
}

// 게시물 여러 개 — 시간은 계정마다 하루 하나로 제안(at 이 있으면 그대로). 모두 「내 차례」로 선다.
export async function createPosts(env, items, { by = '', ideaId = '' } = {}) {
  if (!items.length) return [];
  const d = await db(env); const t = nowMs();
  const accounts = Object.fromEntries((await listAccounts(env)).map((a) => [a.id, a]));
  const { results: existing } = await d.prepare("SELECT account_id, scheduled_at FROM r_posts WHERE scheduled_at>? AND state<>'skipped'").bind(t - DAY).all();
  const times = suggestTimes(items, { accounts, existing, now: t });
  const ids = [];
  const stmts = items.map((it, i) => {
    const id = newId('p'); ids.push(id);
    return d.prepare(`INSERT INTO r_posts (id,idea_id,account_id,format,state,scheduled_at,title,caption,hashtags,first_reply,media,cover,alt,src,by,error,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, it.idea_id || ideaId, it.account_id, it.format, 'review', times[i], clip(it.title || '', 40), it.caption || '', (it.hashtags || []).join(' '),
        it.first_reply || '', JSON.stringify(it.media || []), it.cover || '', it.alt || '', it.src || '', by, it.error || '', t, t);
  });
  for (let i = 0; i < stmts.length; i += 50) await d.batch(stmts.slice(i, i + 50));
  return ids;
}

// 사람이 고치는 칸. 올라갔거나 올리는 중이면 못 고친다.
export async function patchPost(env, post, body) {
  if (['posted', 'publishing'].includes(post.state)) throw fail(409, 'locked');
  const account = await getAccount(env, post.account_id);
  const sets = []; const vals = [];
  const put = (k, v) => { sets.push(`${k}=?`); vals.push(v); };
  if (body.caption != null) put('caption', String(body.caption).slice(0, 4000));
  if (body.title != null) put('title', clip(String(body.title), 40));
  if (body.hashtags != null) put('hashtags', cleanTags(body.hashtags).join(' '));
  if (body.first_reply != null) put('first_reply', String(body.first_reply).slice(0, 2200));
  if (body.trial != null) put('trial', body.trial ? 1 : 0);
  if (body.scheduled_at != null) { const at = Number(body.scheduled_at); if (!(at > 0)) throw fail(400, 'bad_time'); put('scheduled_at', at); }
  if (body.format != null) { if (!FORMATS[account.platform][body.format]) throw fail(400, 'bad_format'); put('format', body.format); }
  if (Array.isArray(body.media)) { // 자산 ID 순서 — 카드 장은 그대로 따라간다
    const old = new Map(post.media.map((m) => [m.asset, m]));
    const add = await assetsByIds(env, body.media.filter((x) => !old.has(x)));
    const addMap = new Map(add.map((a) => [a.id, { asset: a.id, key: a.key, kind: a.kind }]));
    put('media', JSON.stringify(body.media.map((x) => old.get(x) || addMap.get(x)).filter(Boolean).slice(0, 20)));
  }
  if (body.cover != null) put('cover', String(body.cover));
  if (!sets.length) return post;
  put('updated', nowMs());
  const d = await db(env);
  await d.prepare(`UPDATE r_posts SET ${sets.join(', ')} WHERE id=?`).bind(...vals, post.id).run();
  return getPost(env, post.id);
}

export async function actPost(env, post, action, by = '') {
  const next = transition(post.state, action);
  if (!next) throw fail(409, 'bad_transition', `${post.state} → ${action}`);
  if (next === 'scheduled') {
    const p = problems(post, await getAccount(env, post.account_id), action === 'approve' ? nowMs() : 0);
    if (p.length) throw fail(422, 'not_ready', p);
  }
  const d = await db(env);
  const reset = action === 'retry' || action === 'approve';
  await d.prepare(`UPDATE r_posts SET state=?, by=CASE WHEN ?<>'' THEN ? ELSE by END, ${reset ? "progress='{}', attempts=0, error='', " : ''}updated=? WHERE id=?`)
    .bind(next, action === 'approve' ? by : '', by, nowMs(), post.id).run();
  await event(env, 'post.' + action, `${post.title} — ${by}`);
  return getPost(env, post.id);
}
export async function deletePost(env, post) {
  if (['posted', 'publishing'].includes(post.state)) throw fail(409, 'locked');
  const d = await db(env);
  await d.prepare('DELETE FROM r_posts WHERE id=?').bind(post.id).run();
}

// ---------- 가져오기(폴더) ----------
// items: [{account_id, format, title, caption, first_reply, media:[assetId], cover, src, pinned}] — 같은 src 는 다시 만들지 않는다
export async function importPosts(env, items, by) {
  const d = await db(env);
  const accounts = new Map((await listAccounts(env)).map((a) => [a.id, a]));
  const assets = new Map((await assetsByIds(env, items.flatMap((i) => [...(i.media || []), i.cover]))).map((a) => [a.id, a]));
  const out = []; let skipped = 0;
  for (const it of items.slice(0, 120)) {
    const acc = accounts.get(it.account_id);
    if (!acc || !FORMATS[acc.platform][it.format]) { skipped++; continue; }
    if (it.src && await d.prepare("SELECT id FROM r_posts WHERE src=? AND state<>'skipped' LIMIT 1").bind(String(it.src)).first()) { skipped++; continue; }
    const media = (it.media || []).map((id) => assets.get(id)).filter(Boolean).map((a) => ({ asset: a.id, key: a.key, kind: a.kind }));
    const cap = String(it.caption || '');
    out.push({
      account_id: acc.id, format: it.format, title: it.title || cap.split('\n')[0] || '가져옴',
      caption: acc.platform === 'ig' ? stripTags(cap).text : cap, hashtags: acc.platform === 'ig' ? stripTags(cap).tags : [],
      first_reply: String(it.first_reply || ''), media, cover: assets.has(it.cover) ? it.cover : '', src: String(it.src || ''), pinned: !!it.pinned,
      group: String(it.group || '').slice(0, 80),
    });
  }
  // 같은 묶음 이름(예: 한국어·영어의 「P1 나만의AI펫」)은 같은 글감 — 노선도에서 환승으로 잇는다
  const groups = new Map();
  for (const it of out) if (it.group) groups.set(it.group, [...(groups.get(it.group) || []), it]);
  for (const [g, list] of groups) {
    if (list.length < 2) continue;
    const ideaId = newId('i');
    await d.prepare('INSERT INTO r_ideas (id,text,title,src,by,created) VALUES (?,?,?,?,?,?)').bind(ideaId, g, clip(g, 24), 'import', by, nowMs()).run();
    for (const it of list) it.idea_id = ideaId;
  }
  const ids = await createPosts(env, out, { by });
  await event(env, 'import', `${ids.length}개 · 건너뜀 ${skipped}`);
  return { made: ids.length, skipped };
}
// 캡션 끝의 해시태그 줄을 따로 뗀다(Instagram 은 해시태그 칸이 따로다)
export function stripTags(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const tags = [];
  while (lines.length && /^(\s*#[^\s#]+\s*)+$/.test(lines[lines.length - 1])) tags.unshift(...lines.pop().trim().split(/\s+/));
  return { text: lines.join('\n').replace(/\s+$/, ''), tags: cleanTags(tags) };
}

// ---------- 만들기(Claude) ----------
function normSlides(raw, { assets, max }) {
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (s && s.asset && assets.has(s.asset)) out.push({ asset: s.asset });
    else if (s && s.card && CARD_KINDS.includes(s.card.t)) {
      const c = { ...s.card };
      if (c.photo && !(assets.has(c.photo) && assets.get(c.photo).kind === 'image')) delete c.photo;
      out.push({ card: c });
    }
    if (out.length >= max) break;
  }
  return out;
}
// Claude 답 하나 → 우리 게시물 모양(아직 이미지는 없음)
export function normPost(raw, account, assets) {
  const F = FORMATS[account.platform];
  let format = F[raw.format] ? raw.format : '';
  let slides = normSlides(raw.slides, { assets, max: 20 });
  const isVid = (s) => s.asset && assets.get(s.asset).kind === 'video';
  if (format === 'reel' && !slides.some(isVid)) format = '';
  if (format === 'reel') slides = [slides.find(isVid)];
  if (!format) {
    if (account.platform === 'ig') format = slides.length > 1 ? 'carousel' : 'image';
    else if (account.platform === 'th') format = slides.length > 1 ? 'carousel' : slides.length ? (isVid(slides[0]) ? 'video' : 'image') : 'text';
    else format = slides.length ? 'image' : 'text';
  }
  slides = slides.slice(0, F[format].max);
  const cover = raw.cover && assets.has(raw.cover) && assets.get(raw.cover).kind === 'image' ? raw.cover : '';
  return {
    format, title: clip(String(raw.title || String(raw.caption || '').split('\n')[0] || ''), 40),
    caption: String(raw.caption || '').slice(0, LIMITS.caption[account.platform] + 200),
    hashtags: account.platform === 'ig' ? cleanTags(raw.hashtags) : [],
    first_reply: String(raw.first_reply || '').slice(0, LIMITS.reply[account.platform]),
    alt: String(raw.alt || '').slice(0, 200), slides, cover,
  };
}

// 카드 장을 찍어 소재로 저장 → media 항목. 못 찍은 장은 key 없이 남긴다(problems 가 「다시 찍기」를 알린다).
async function buildMedia(env, slides, { assets, account, format, origin, reuse = [] }) {
  const o = originOf(env, origin);
  const jobs = []; const media = [];
  slides.forEach((s, i) => {
    if (s.asset) { const a = assets.get(s.asset); media.push({ asset: a.id, key: a.key, kind: a.kind }); return; }
    const same = reuse.find((m) => m.card && m.key && JSON.stringify(m.card) === JSON.stringify(s.card));
    if (same) { media.push(same); return; }
    const photo = s.card.photo && assets.get(s.card.photo);
    const story = format === 'story';
    media.push({ asset: '', key: '', kind: 'image', card: s.card });
    jobs.push({ at: media.length - 1, height: story ? 1920 : 1350, html: cardHtml(s.card, { photo: photo ? mediaUrl(o, photo.key) : '', idx: i + 1, total: slides.length, handle: account.username, story }) });
  });
  if (jobs.length && renderReady(env) && mediaReady(env)) {
    const shots = await renderMany(env, jobs);
    for (let j = 0; j < jobs.length; j++) {
      if (!shots[j]) continue;
      const a = await addAsset(env, { bytes: shots[j], mime: 'image/jpeg', kind: 'image', w: 1080, h: jobs[j].height, title: `카드 · ${media[jobs[j].at].card.title || media[jobs[j].at].card.t}`.replace(/\\n|\n/g, ' '), src: 'card' });
      media[jobs[j].at] = { ...media[jobs[j].at], asset: a.id, key: a.key };
    }
  }
  return media;
}
const cardsMissing = (media) => media.some((m) => m.card && !m.key);
const missingNote = (env) => (renderReady(env) ? '카드 일부를 못 찍었습니다 — 다시 찍기' : '카드 찍기(Browser Rendering)가 꺼져 있습니다 — 사진 소재로 바꾸거나 다시 찍기');

function imageBlocks(env, assets, origin) {
  const o = originOf(env, origin);
  if (!/^https:\/\//.test(o) || /localhost|127\.0\.0\.1/.test(o)) return [];
  return assets.filter((a) => a.kind === 'image').slice(0, 6).map((a) => ({ type: 'image', source: { type: 'url', url: mediaUrl(o, a.key) } }));
}
async function askWithImages(env, p, imgs, opts) {
  if (!imgs.length) return ask(env, p.system, p.user, opts);
  try { return await ask(env, p.system, [...imgs, { type: 'text', text: p.user }], opts); }
  catch (e) { if (/image|url|fetch|media/i.test(String(e.message))) return ask(env, p.system, p.user, opts); throw e; } // 그림을 못 가져오면 글로만
}

export async function makeIdea(env, { text, accountIds, assetIds, by, origin }) {
  const body = String(text || '').trim().slice(0, 3000);
  if (body.length < 2) throw fail(400, 'text_required');
  const all = await listAccounts(env);
  const accounts = all.filter((a) => (accountIds || []).includes(a.id));
  if (!accounts.length) throw fail(400, 'no_accounts');
  const picked = await assetsByIds(env, assetIds);
  const library = new Map(picked.map((a) => [a.id, a]));
  const brand = await getBrand(env);
  const d = await db(env);
  const { results: recent } = await d.prepare(`SELECT title FROM r_posts WHERE account_id IN (${accounts.map(() => '?').join(',')}) AND title<>'' ORDER BY created DESC LIMIT 10`).bind(...accounts.map((a) => a.id)).all();
  const p = makePrompt({ brand, text: body, accounts, assets: picked, recent });
  const out = await askWithImages(env, p, imageBlocks(env, picked, origin), { maxTokens: p.maxTokens, mock: 'make', mockCtx: { text: body, accounts, assets: picked } });
  const ideaId = newId('i');
  const items = [];
  for (const acc of accounts) {
    const raw = (Array.isArray(out.posts) ? out.posts : []).find((x) => x && x.account === acc.id);
    if (!raw) continue;
    const n = normPost(raw, acc, library);
    const media = await buildMedia(env, n.slides, { assets: library, account: acc, format: n.format, origin });
    items.push({ account_id: acc.id, format: n.format, title: n.title, caption: n.caption, hashtags: n.hashtags, first_reply: n.first_reply, alt: n.alt, media, cover: n.cover, src: 'claude', error: cardsMissing(media) ? missingNote(env) : '' });
  }
  if (!items.length) throw fail(502, 'ai_empty');
  await d.prepare('INSERT INTO r_ideas (id,text,title,src,by,created) VALUES (?,?,?,?,?,?)').bind(ideaId, body, clip(String(out.title || body), 24), 'claude', by, nowMs()).run();
  const ids = await createPosts(env, items, { by, ideaId });
  await event(env, 'make', `${clip(body, 40)} → ${ids.length}개`);
  return { idea: ideaId, posts: ids };
}

// 한 마디로 고치기 — 그 게시물만 다시. 바뀐 카드만 다시 찍는다.
export async function revisePost(env, post, say, origin) {
  if (['posted', 'publishing'].includes(post.state)) throw fail(409, 'locked');
  const ask1 = String(say || '').trim().slice(0, 600);
  if (!ask1) throw fail(400, 'say_required');
  const account = await getAccount(env, post.account_id);
  const assets = new Map((await assetsByIds(env, [...post.media.map((m) => m.asset), ...post.media.map((m) => m.card && m.card.photo), post.cover])).map((a) => [a.id, a]));
  const current = {
    account: account.id, format: post.format, title: post.title, caption: post.caption, hashtags: cleanTags(post.hashtags), first_reply: post.first_reply, alt: post.alt,
    slides: post.media.map((m) => (m.card ? { card: m.card } : { asset: m.asset })), cover: post.cover,
  };
  const p = revisePrompt({ brand: await getBrand(env), post: current, account, say: ask1, assets: [...assets.values()] });
  const out = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'revise', mockCtx: { post: current } });
  const n = normPost({ ...current, ...out }, account, assets);
  const media = await buildMedia(env, n.slides, { assets, account, format: n.format, origin, reuse: post.media });
  const d = await db(env);
  await d.prepare('UPDATE r_posts SET format=?, title=?, caption=?, hashtags=?, first_reply=?, alt=?, media=?, cover=?, error=?, updated=? WHERE id=?')
    .bind(n.format, n.title, n.caption, n.hashtags.join(' '), n.first_reply, n.alt, JSON.stringify(media), n.cover, cardsMissing(media) ? missingNote(env) : '', nowMs(), post.id).run();
  await event(env, 'post.revised', `${n.title} — ${clip(ask1, 40)}`);
  return getPost(env, post.id);
}
// 못 찍은 카드만 다시
export async function rerender(env, post, origin) {
  const account = await getAccount(env, post.account_id);
  const assets = new Map((await assetsByIds(env, [...post.media.map((m) => m.asset), ...post.media.map((m) => m.card && m.card.photo)])).map((a) => [a.id, a]));
  const slides = post.media.map((m) => (m.card ? { card: m.card } : { asset: m.asset })).filter((s) => s.card || assets.has(s.asset));
  const media = await buildMedia(env, slides, { assets, account, format: post.format, origin, reuse: post.media });
  const d = await db(env);
  await d.prepare('UPDATE r_posts SET media=?, error=?, updated=? WHERE id=?').bind(JSON.stringify(media), cardsMissing(media) ? missingNote(env) : '', nowMs(), post.id).run();
  return getPost(env, post.id);
}

// ---------- 게시 ----------
function platformApi(env, account) {
  const k = account.platform;
  return {
    create: (params) => meta.createContainer(env, k, account.platform_id, account.token, params),
    status: (id) => meta.containerStatus(env, k, id, account.token),
    publish: (id) => meta.publishContainer(env, k, account.platform_id, account.token, id),
    comment: (mediaId, text) => meta.comment(env, mediaId, account.token, text),
  };
}
async function setPost(env, id, fields, expectUpdated) {
  const d = await db(env); const keys = Object.keys(fields);
  const sql = `UPDATE r_posts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated=? WHERE id=?${expectUpdated != null ? ' AND updated=?' : ''}`;
  const vals = keys.map((k) => (typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]));
  const r = await d.prepare(sql).bind(...vals, nowMs(), id, ...(expectUpdated != null ? [expectUpdated] : [])).run();
  return !!(r.meta && r.meta.changes);
}

// 게시물 하나를 한 걸음 — 점유(updated 낙관적 잠금)한 쪽만 진행한다. 반환: 결과 state
export async function publishOne(env, post, { budget = 30, origin } = {}) {
  const lease = nowMs();
  const d = await db(env);
  const won = await d.prepare("UPDATE r_posts SET state='publishing', updated=? WHERE id=? AND updated=? AND state IN ('scheduled','publishing')").bind(lease, post.id, post.updated).run();
  if (!(won.meta && won.meta.changes)) return 'busy';
  const account = await accountWithToken(env, post.account_id);
  const o = originOf(env, origin);
  const done = (fields) => setPost(env, post.id, fields, lease);
  if (!account || account.status !== 'linked' || !account.token) {
    await done({ state: 'failed', error: '계정 연결 전이거나 만료됨 — 다시 연결한 뒤 다시' });
    return 'failed';
  }
  const shaped = {
    format: post.format, caption: composeCaption(post, account.platform), first_reply: post.first_reply, trial: post.trial,
    media: post.media.map((m) => ({ url: mediaUrl(o, m.key), kind: m.kind })),
    cover_url: post.cover ? await coverUrl(env, post.cover, o) : '',
    progress: post.progress, platform_post_id: post.platform_post_id,
  };
  try {
    const r = await step(shaped, { platform: account.platform, api: platformApi(env, account), budget });
    if (r.state === 'posted') {
      let permalink = post.permalink;
      try { permalink = (await meta.postInfo(env, account.platform, r.platform_post_id, account.token)).permalink || permalink; } catch { /* 나중에 지표 때 */ }
      await done({ state: 'posted', progress: r.progress, platform_post_id: r.platform_post_id, permalink, warn: r.warn || '', error: '', published_at: nowMs() });
      await event(env, 'post.posted', `${meta.kindName(account.platform)} @${account.username} — ${post.title}`);
    } else if (r.state === 'failed') {
      await done({ state: 'failed', progress: {}, error: clip(r.error, 300) });
      await event(env, 'post.failed', `${post.title} — ${r.error}`, 'bad');
    } else await done({ state: 'publishing', progress: r.progress, platform_post_id: r.platform_post_id || '' });
    return r.state;
  } catch (e) {
    const msg = clip(String((e && e.message) || e), 300);
    if (e instanceof meta.MetaError && e.tokenProblem) {
      await markExpired(env, account.id, msg);
      await done({ state: 'failed', error: '토큰 만료 — 다시 연결: ' + msg });
      return 'failed';
    }
    const attempts = (post.attempts || 0) + 1;
    const give = attempts >= 3 && !(e instanceof meta.MetaError && e.rateLimited);
    await done({ state: give ? 'failed' : 'publishing', attempts, error: msg });
    if (give) await event(env, 'post.failed', `${post.title} — ${msg}`, 'bad');
    return give ? 'failed' : 'publishing';
  }
}
async function coverUrl(env, assetId, o) {
  const [a] = await assetsByIds(env, [assetId]);
  return a ? mediaUrl(o, a.key) : '';
}

// 크론 — 때가 된 예약 + 이어 가야 할 게시. 한 틱에 외부 호출 40번 안쪽(무료 요금제 50).
export async function publishDue(env, now = nowMs()) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM r_posts WHERE (state='scheduled' AND scheduled_at<=?) OR state='publishing' ORDER BY scheduled_at LIMIT 12").bind(now).all();
  let budget = 40; const out = [];
  for (const r of results) {
    if (budget < 4) break;
    const post = rowPost(r);
    if (post.state === 'scheduled' && !isDue(post, now)) continue;
    if (post.state === 'scheduled' && (await overDaily(env, post.account_id))) { out.push({ id: post.id, result: 'daily_limit' }); continue; }
    const use = Math.min(budget, 30);
    out.push({ id: post.id, result: await publishOne(env, post, { budget: use }) });
    budget -= use; // 보수적으로 — 실제로 덜 썼어도 한 틱은 넉넉히
  }
  return out;
}
async function overDaily(env, accountId) {
  const d = await db(env);
  const a = await d.prepare('SELECT platform FROM r_accounts WHERE id=?').bind(accountId).first();
  if (!a) return false;
  const r = await d.prepare("SELECT COUNT(*) AS n FROM r_posts WHERE account_id=? AND state='posted' AND published_at>?").bind(accountId, nowMs() - DAY).first();
  return r.n >= (LIMITS.daily[a.platform] || 100);
}
// 지금 올리기 — 예약으로 바꾸고 바로 몇 걸음(처리 중이면 크론이 잇는다)
export async function publishNow(env, post, by, origin) {
  const d = await db(env);
  if (['review', 'scheduled', 'failed'].includes(post.state)) { // 시간을 지금으로 — 승인 검사(시간 지남)에 걸리지 않게 먼저
    await d.prepare('UPDATE r_posts SET scheduled_at=? WHERE id=?').bind(nowMs(), post.id).run();
    post = await getPost(env, post.id);
  }
  if (post.state === 'review') post = await actPost(env, post, 'approve', by);
  else if (post.state === 'failed') post = await actPost(env, post, 'retry', by);
  if (post.state !== 'scheduled' && post.state !== 'publishing') throw fail(409, 'bad_transition');
  for (let i = 0; i < 3; i++) {
    const cur = await getPost(env, post.id);
    if (!['scheduled', 'publishing'].includes(cur.state)) break;
    const r = await publishOne(env, cur, { budget: 30, origin });
    if (r !== 'publishing') break;
    await new Promise((res) => setTimeout(res, 4000));
  }
  return getPost(env, post.id);
}

// ---------- 지표 ----------
export async function collectMetrics(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM r_posts WHERE state='posted' AND platform_post_id<>'' AND published_at>? ORDER BY published_at DESC LIMIT 18").bind(nowMs() - 14 * DAY).all();
  const tokens = {}; let n = 0;
  for (const r of results) {
    const post = rowPost(r);
    if (!(post.account_id in tokens)) tokens[post.account_id] = await accountWithToken(env, post.account_id);
    const a = tokens[post.account_id];
    if (!a || a.status !== 'linked' || !a.token) continue;
    try {
      const info = await meta.postInfo(env, a.platform, post.platform_post_id, a.token);
      let ins = {};
      try { ins = await meta.postInsights(env, a.platform, post.platform_post_id, a.token); } catch { /* 권한 없으면 기본만 */ }
      const metrics = { likes: ins.likes ?? info.likes, comments: ins.comments ?? ins.replies ?? info.comments, reach: ins.reach ?? null, views: ins.views ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null, at: nowMs() };
      await d.prepare("UPDATE r_posts SET metrics=?, permalink=COALESCE(NULLIF(?, ''), permalink) WHERE id=?").bind(JSON.stringify(metrics), info.permalink || '', post.id).run();
      n++;
    } catch (e) {
      if (e instanceof meta.MetaError && e.tokenProblem) { await markExpired(env, a.id, e.message); tokens[post.account_id] = null; }
    }
  }
  return n;
}
// 옛 홍보실 미디어(m/·c/) — 옮긴 뒤 한 번 지운다
export async function cleanupOldMedia(env) {
  if ((await metaGet(env, 'kv_old')) !== '1') return 0;
  const n = (await deletePrefix(env, 'm/')) + (await deletePrefix(env, 'c/'));
  await metaSet(env, 'kv_old', '0');
  await event(env, 'cleanup', `옛 미디어 ${n}개 지움`);
  return n;
}
export async function recentEvents(env, n = 40) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT kind, level, detail, at FROM r_events ORDER BY id DESC LIMIT ?').bind(n).all();
  return results;
}
