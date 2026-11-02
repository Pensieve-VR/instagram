// 운영 동작 — API 와 크론이 같이 쓴다. 생성·예약·게시·지표·요약.
import { db, event, J, rowPost, rowChannel, rowService } from './db.js';
import { ask, aiReady } from './ai.js';
import { candidatesPrompt, profilePrompt, materialPrompt, postPrompt, revisePrompt, summaryPrompt } from './prompts.js';
import * as meta from './meta.js';
import { seal, open } from './crypto.js';
import { cardHtml, renderJpeg, renderReady } from './render.js';
import { mediaReady, putMedia, deleteMedia } from './media.js';
import { mergeSettings, nextSlots, pickAngle, transition, isDue, cleanTags, clip, LIMITS, hm, dayKey, kstParts, validHandle, cleanHandle, DAY } from './plan.js';
import { idFor } from './http.js';

const nowMs = () => Date.now();
export const mediaUrl = (origin, key) => `${origin}/media/${key}`;

// ---------- 읽기 ----------
export async function getService(env, space, id) {
  const d = await db(env);
  return rowService(await d.prepare('SELECT * FROM services WHERE id=? AND space=?').bind(id, space).first());
}
export async function listServices(env, space) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT id,name,handle,homepage,oneliner,created,updated FROM services WHERE space=? ORDER BY created').bind(space).all();
  return results;
}
export async function channelsOf(env, serviceId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM channels WHERE service_id=? ORDER BY kind').bind(serviceId).all();
  return results.map(rowChannel);
}
export async function gatesOf(env, serviceId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT kind, done FROM gates WHERE service_id=?').bind(serviceId).all();
  const g = { signup: 0, connect: 0, profile: 0 };
  results.forEach((r) => { g[r.kind] = r.done; });
  return g;
}
export async function materialsOf(env, serviceId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM materials WHERE service_id=? ORDER BY created').bind(serviceId).all();
  return results.map((m) => ({ ...m, summary: J(m.summary, null) }));
}
export async function postsOf(env, serviceId, fromMs, toMs) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM posts WHERE service_id=? AND scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at').bind(serviceId, fromMs, toMs).all();
  return results.map(rowPost);
}
export async function getPost(env, serviceId, postId) {
  const d = await db(env);
  return rowPost(await d.prepare('SELECT * FROM posts WHERE id=? AND service_id=?').bind(postId, serviceId).first());
}
export async function recentEvents(env, serviceId, n = 30) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT kind, level, detail, at FROM events WHERE service_id=? ORDER BY at DESC LIMIT ?').bind(serviceId, n).all();
  return results;
}
export async function latestDaily(env, serviceId) {
  const d = await db(env);
  const r = await d.prepare('SELECT day, data FROM daily WHERE service_id=? ORDER BY day DESC LIMIT 1').bind(serviceId).first();
  return r ? { day: r.day, ...J(r.data, {}) } : null;
}

// ---------- 서비스 · 후보 ----------
export async function createService(env, space, { name, homepage = '', brief = '' }) {
  const d = await db(env); const t = nowMs();
  const id = idFor('s');
  await d.prepare('INSERT INTO services (id,space,name,homepage,brief,settings,created,updated) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, space, name, homepage, brief, '{}', t, t).run();
  await event(env, id, 'service.created', name);
  return getService(env, space, id);
}

// 후보 — 비었는지는 서버가 Instagram 을 긁어 보지 않는다(약관·차단). 사람이 Instagram 에서 한 번 보고 표시한다.
// check: unchecked(확인 전) · free(비었음) · taken(있음). taken 은 다음 추천에서 빠진다.
export const CHECKS = ['unchecked', 'free', 'taken'];
const normHandle = (h) => cleanHandle(h).replace(/[._]/g, ''); // 마침표·밑줄만 다른 변형은 같은 것으로

// 다시 추천 — 확인 전·비었음 후보는 버리고(사람이 고른 비었음은 남긴다) 새 6개. 있음으로 표시한 것과 지금까지 보여 준 것은 제외.
export async function genCandidates(env, service, { hint = '' } = {}) {
  const prev = Array.isArray(service.candidates) ? service.candidates : [];
  const keep = prev.filter((c) => c.check === 'taken' || c.check === 'free');
  const exclude = [...new Set(prev.map((c) => c.handle))];
  const p = candidatesPrompt({ ...service, hint: String(hint || '').slice(0, 200), exclude });
  const out = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'candidates' });
  const seen = new Set(prev.map((c) => normHandle(c.handle)));
  const fresh = [];
  for (const c of Array.isArray(out.candidates) ? out.candidates : []) {
    const handle = cleanHandle(c.handle);
    if (!validHandle(handle) || seen.has(normHandle(handle))) continue;
    seen.add(normHandle(handle));
    fresh.push({ handle, why: String(c.why || '').slice(0, 60), check: 'unchecked' });
    if (fresh.length >= 6) break;
  }
  const list = [...keep, ...fresh];
  const d = await db(env);
  await d.prepare('UPDATE services SET candidates=?, updated=? WHERE id=?').bind(JSON.stringify(list), nowMs(), service.id).run();
  return { candidates: list };
}

// 사람이 Instagram 에서 본 결과를 적는다. 후보에 없는 이름(직접 쓴 것)도 적을 수 있다.
export async function markCandidate(env, service, handle, check) {
  const h = cleanHandle(handle);
  if (!validHandle(h)) throw Object.assign(new Error('bad_handle'), { status: 400 });
  if (!CHECKS.includes(check)) throw Object.assign(new Error('bad_check'), { status: 400 });
  const list = Array.isArray(service.candidates) ? service.candidates.slice() : [];
  const i = list.findIndex((c) => c.handle === h);
  if (i >= 0) list[i] = { ...list[i], check };
  else list.push({ handle: h, why: '직접 쓴 이름', check });
  const d = await db(env);
  await d.prepare('UPDATE services SET candidates=?, updated=? WHERE id=?').bind(JSON.stringify(list), nowMs(), service.id).run();
  if (check === 'taken' && service.handle === h) { // 고른 이름이 이미 있었다 → 이름 고르기로 되돌린다
    await d.prepare("UPDATE services SET handle='', updated=? WHERE id=?").bind(nowMs(), service.id).run();
    await d.prepare("UPDATE gates SET done=0 WHERE service_id=? AND kind='signup'").bind(service.id).run();
  }
  await event(env, service.id, 'handle.checked', `@${h} — ${{ free: '비었음', taken: '있음', unchecked: '확인 전' }[check]}`);
  return { candidates: list };
}

export async function pickHandle(env, service, handle) {
  const h = cleanHandle(handle);
  if (!validHandle(h)) throw Object.assign(new Error('bad_handle'), { status: 400 });
  const known = (service.candidates || []).find((c) => c.handle === h);
  if (known && known.check === 'taken') throw Object.assign(new Error('handle_taken'), { status: 409 });
  const d = await db(env);
  await d.prepare('UPDATE services SET handle=?, updated=? WHERE id=?').bind(h, nowMs(), service.id).run();
  await d.prepare('INSERT OR IGNORE INTO gates (service_id, kind, done) VALUES (?,?,0)').bind(service.id, 'signup').run();
  await event(env, service.id, 'handle.picked', '@' + h);
  return h;
}

export async function setGate(env, service, kind, done) {
  if (!['signup', 'connect', 'profile'].includes(kind)) throw Object.assign(new Error('bad_gate'), { status: 400 });
  const d = await db(env);
  await d.prepare('INSERT INTO gates (service_id, kind, done) VALUES (?,?,?) ON CONFLICT(service_id, kind) DO UPDATE SET done=excluded.done').bind(service.id, kind, done ? 1 : 0).run();
  await event(env, service.id, 'gate.' + kind, done ? '통과' : '다시');
}

// 소개문 — 사용자가 적은 설명으로만 3안을 만든다. 설명이 없으면 만들지 않는다(지어내지 않게).
export async function genProfile(env, service, { brief, homepage }) {
  const text = String(brief ?? service.brief ?? '').trim().slice(0, 2000);
  if (text.length < 5) throw Object.assign(new Error('brief_required'), { status: 400 });
  let home = String(homepage ?? service.homepage ?? '').trim().slice(0, 300);
  if (home && !/^https?:\/\//i.test(home)) home = 'https://' + home;
  const p = profilePrompt({ ...service, brief: text, homepage: home });
  const out = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'profile' });
  const options = (Array.isArray(out.options) ? out.options : []).map((o) => ({ bio: clip(String((o && o.bio) || ''), 150), why: String((o && o.why) || '').slice(0, 40) })).filter((o) => o.bio).slice(0, 3);
  if (!options.length) throw Object.assign(new Error('ai_empty'), { status: 502 });
  const prevProfile = mergeSettings(service.settings).profile || {};
  const profile = { ...prevProfile, monogram: String(out.monogram || service.name.slice(0, 1)).slice(0, 2), palette: ['rose', 'navy', 'teal', 'ochre', 'violet'].includes(out.palette) ? out.palette : 'rose', options };
  const d = await db(env);
  const settings = mergeSettings(service.settings); settings.profile = profile;
  await d.prepare('UPDATE services SET brief=?, homepage=?, settings=?, updated=? WHERE id=?').bind(text, home, JSON.stringify(settings), nowMs(), service.id).run();
  await d.prepare('INSERT OR IGNORE INTO gates (service_id, kind, done) VALUES (?,?,0)').bind(service.id, 'profile').run();
  return profile;
}

// 고른(고친) 소개문을 확정한다
export async function setBio(env, service, bio) {
  const b = String(bio || '').trim();
  if (!b) throw Object.assign(new Error('bio_required'), { status: 400 });
  if (b.length > 150) throw Object.assign(new Error('bio_too_long'), { status: 400 });
  const settings = mergeSettings(service.settings); settings.profile = { ...(settings.profile || {}), bio: b };
  const d = await db(env);
  await d.prepare('UPDATE services SET bio=?, settings=?, updated=? WHERE id=?').bind(b, JSON.stringify(settings), nowMs(), service.id).run();
  return settings.profile;
}

// ---------- 채널(토큰) ----------
export async function saveChannel(env, serviceId, kind, { token, expiresAt, profile }) {
  const d = await db(env); const t = nowMs();
  const enc = await seal(env, token);
  const existing = await d.prepare('SELECT id FROM channels WHERE service_id=? AND kind=?').bind(serviceId, kind).first();
  const id = existing ? existing.id : idFor('c');
  const metaJson = JSON.stringify({ picture: profile.picture, name: profile.name, followers: profile.followers, bio: profile.bio });
  if (existing) {
    await d.prepare('UPDATE channels SET platform_id=?, username=?, token_enc=?, token_exp=?, meta=?, status=?, updated=? WHERE id=?')
      .bind(profile.id, profile.username, enc, expiresAt, metaJson, 'linked', t, id).run();
  } else {
    await d.prepare('INSERT INTO channels (id,service_id,kind,platform_id,username,token_enc,token_exp,meta,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, serviceId, kind, profile.id, profile.username, enc, expiresAt, metaJson, 'linked', t, t).run();
  }
  await event(env, serviceId, 'channel.linked', `${meta.kindName(kind)} @${profile.username}`);
  const all = await channelsOf(env, serviceId);
  if (all.filter((c) => c.hasToken).length >= 1) await d.prepare('INSERT INTO gates (service_id, kind, done) VALUES (?,?,1) ON CONFLICT(service_id, kind) DO UPDATE SET done=1').bind(serviceId, 'connect').run();
  return id;
}
async function channelWithToken(env, serviceId, kind) {
  const d = await db(env);
  const r = await d.prepare('SELECT * FROM channels WHERE service_id=? AND kind=?').bind(serviceId, kind).first();
  if (!r || !r.token_enc) return null;
  return { ...r, token: await open(env, r.token_enc) };
}
async function markExpired(env, channelId, serviceId, kind, why) {
  const d = await db(env);
  await d.prepare('UPDATE channels SET status=?, updated=? WHERE id=?').bind('expired', nowMs(), channelId).run();
  await event(env, serviceId, 'channel.expired', `${meta.kindName(kind)} — ${why}`, 'bad');
}

export async function refreshTokens(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM channels WHERE token_enc<>\'\' AND status=\'linked\' AND token_exp < ?').bind(nowMs() + 10 * DAY).all();
  let n = 0;
  for (const c of results) {
    try {
      const r = await meta.refresh(env, c.kind, await open(env, c.token_enc));
      await d.prepare('UPDATE channels SET token_enc=?, token_exp=?, updated=? WHERE id=?').bind(await seal(env, r.token), r.expiresAt, nowMs(), c.id).run();
      await event(env, c.service_id, 'token.refreshed', meta.kindName(c.kind)); n++;
    } catch (e) {
      if (e instanceof meta.MetaError && e.tokenProblem) await markExpired(env, c.id, c.service_id, c.kind, e.message);
      else await event(env, c.service_id, 'token.refresh_failed', `${meta.kindName(c.kind)} — ${e.message}`, 'warn');
    }
  }
  return n;
}

// ---------- 소재 ----------
export async function addMaterial(env, service, { type, title = '', r2_key = '', mime = '', url = '', text = '', content = '' }) {
  const d = await db(env); const id = idFor('m');
  let summary = null;
  if (aiReady(env) && (content || text || url)) {
    try {
      const p = materialPrompt({ name: service.name, type, title: title || url, content: content || text });
      const out = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'material' });
      summary = { title: String(out.title || title || '').slice(0, 40), summary: String(out.summary || '').slice(0, 600), facts: (Array.isArray(out.facts) ? out.facts : []).map((f) => String(f).slice(0, 200)).slice(0, 8), numbers: Array.isArray(out.numbers) ? out.numbers.slice(0, 6) : [], tone: String(out.tone || '').slice(0, 120) };
    } catch (e) { summary = { title, summary: '', facts: [], numbers: [], error: String(e.message).slice(0, 120) }; }
  }
  await d.prepare('INSERT INTO materials (id,service_id,type,title,r2_key,mime,url,text,summary,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, service.id, type, (summary && summary.title) || title || url || type, r2_key, mime, url, String(text || content || '').slice(0, 20000), JSON.stringify(summary || {}), nowMs()).run();
  await event(env, service.id, 'material.added', `${type} · ${(summary && summary.title) || title || url}`);
  return id;
}

// 링크 → 글. HTML 에서 본문만 대충 추린다(스크립트·스타일 제거).
export async function fetchPageText(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('bad_url'), { status: 400 });
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  let r;
  try { r = await fetch(u, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; pensieve-hongbo/1.0)', accept: 'text/html,text/plain' }, redirect: 'follow' }); }
  finally { clearTimeout(t); }
  if (!r.ok) throw Object.assign(new Error(`fetch_${r.status}`), { status: 400 });
  const html = (await r.text()).slice(0, 400000);
  const title = (html.match(/<title[^>]*>([^<]{1,200})/i) || [])[1] || '';
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return { title: title.trim(), text: text.slice(0, 12000) };
}

// 소재를 지울 때 — 그 이미지를 기다리던 미게시 글은 이미지를 비우고 승인 대기로 돌린다(조용히 깨진 채 올라가지 않게)
export async function detachMaterial(env, serviceId, r2Key) {
  if (!r2Key) return 0;
  const d = await db(env);
  const { results } = await d.prepare("SELECT id, media FROM posts WHERE service_id=? AND state IN ('draft','review','scheduled','failed') AND media LIKE ?").bind(serviceId, `%${r2Key}%`).all();
  for (const r of results) {
    const media = J(r.media, []).filter((m) => m.r2_key !== r2Key);
    await d.prepare("UPDATE posts SET media=?, state='review', error=?, updated=? WHERE id=?").bind(JSON.stringify(media), '소재 이미지가 지워짐 — 다른 이미지를 넣거나 건너뜀', nowMs(), r.id).run();
  }
  if (results.length) await event(env, serviceId, 'material.detached', `${results.length}개 글이 승인 대기로`, 'warn');
  return results.length;
}

// 카드 글이 바뀌면 카드 이미지도 다시 찍는다(생성된 카드일 때만 — 소재 이미지는 건드리지 않는다)
export async function rerenderCard(env, service, post, origin) {
  const m = post.media[0];
  const generated = !m || (m.r2_key && m.r2_key.startsWith('c/'));
  if (post.channel !== 'ig' || !post.card || !generated || !renderReady(env) || !mediaReady(env)) return post.media;
  const jpg = await renderJpeg(env, cardHtml({ ...post.card, angle: post.angle, service: service.name, handle: service.handle }), { width: 1080, height: 1350 });
  const key = `c/${service.id}/${post.id}-${Date.now().toString(36)}.jpg`;
  await putMedia(env, key, jpg, 'image/jpeg');
  if (m && m.r2_key) await deleteMedia(env, m.r2_key);
  return [{ r2_key: key, url: mediaUrl(origin, key), mime: 'image/jpeg' }];
}

// ---------- 생성 · 계획 ----------
function pickMaterial(materials, posts, { wantImage }) {
  const pool = materials.filter((m) => (wantImage ? m.type === 'image' : true));
  if (!pool.length) return null;
  const uses = {}; posts.forEach((p) => { if (p.material_id) uses[p.material_id] = (uses[p.material_id] || 0) + 1; });
  return pool.slice().sort((a, b) => (uses[a.id] || 0) - (uses[b.id] || 0) || a.created - b.created)[0];
}

export async function generatePost(env, service, channel, { angle, materials, recent, when, hasImage }) {
  const settings = mergeSettings(service.settings);
  const p = postPrompt({ service, channel, angle, materials: materials.map((m) => ({ id: m.id, title: m.title, summary: (m.summary && m.summary.summary) || m.text.slice(0, 300), facts: (m.summary && m.summary.facts) || [] })), recent, when, tone: settings.tone, hasImage });
  const draft = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'post' });
  let final = draft;
  try { const r = revisePrompt({ channel, draft, angle }); final = await ask(env, r.system, r.user, { maxTokens: r.maxTokens, mock: 'revise' }); } catch { final = draft; } // 다듬기 실패는 초안으로
  const text = clip(String(final.text || draft.text || ''), channel === 'ig' ? LIMITS.igCaption : LIMITS.thText);
  const card = channel === 'ig' && final.card && typeof final.card === 'object'
    ? { headline: String(final.card.headline || final.hook || '').slice(0, 24), sub: String(final.card.sub || '').slice(0, 60), bullets: (Array.isArray(final.card.bullets) ? final.card.bullets : []).map((b) => String(b).slice(0, 32)).slice(0, 3) }
    : null;
  return {
    hook: clip(String(final.hook || text.split('\n')[0] || ''), LIMITS.hook),
    text,
    hashtags: channel === 'ig' ? cleanTags(final.hashtags) : [],
    card,
    alt: String(final.alt || '').slice(0, 200),
    material_id: String(final.uses_material || '').match(/^m[a-z0-9]{6,24}$/) ? String(final.uses_material) : '',
  };
}

export async function planWeek(env, service, { origin, fromMs = nowMs(), days = 7, channels: only = null } = {}) {
  const d = await db(env);
  const settings = mergeSettings(service.settings);
  const linked = (await channelsOf(env, service.id)).filter((c) => c.hasToken && c.status === 'linked').map((c) => c.kind);
  const materials = await materialsOf(env, service.id);
  const since = fromMs - 21 * DAY; const until = fromMs + days * DAY;
  const existing = await postsOf(env, service.id, since, until + DAY);
  const made = [];
  for (const kind of ['ig', 'th']) {
    if (only && !only.includes(kind)) continue;
    if (!linked.includes(kind) && env.MOCK_AI !== '1') continue; // 연결 안 된 노선에는 역을 세우지 않는다
    const mine = existing.filter((p) => p.channel === kind && p.state !== 'skipped');
    const taken = new Set(existing.filter((p) => p.channel === kind).map((p) => p.scheduled_at)); // 건너뛴 자리도 비워 둔다 — 건너뜀은 "그 자리엔 안 올림"
    const slots = nextSlots(settings[kind].slots, fromMs, until, taken);
    for (const at of slots) {
      // 두 번 눌렀거나 두 요청이 겹쳤을 때 같은 자리에 둘 세우지 않는다
      const dup = await d.prepare("SELECT id FROM posts WHERE service_id=? AND channel=? AND scheduled_at=? AND state<>'skipped' LIMIT 1").bind(service.id, kind, at).first();
      if (dup) continue;
      const recent = mine.filter((p) => p.state !== 'skipped').slice(-8);
      const angle = pickAngle(recent.map((p) => p.angle), settings.angles);
      const mat = kind === 'ig' ? pickMaterial(materials, mine, { wantImage: true }) : null;
      const when = `${dayKey(at)} ${hm(at)} (${'일월화수목금토'[kstParts(at).dow]})`;
      const id = idFor('p'); const t = nowMs();
      let gen;
      try {
        gen = await generatePost(env, service, kind, { angle, materials, recent: recent.map((p) => ({ angle: p.angle, hook: p.hook })), when, hasImage: !!mat });
      } catch (e) {
        await event(env, service.id, 'post.generate_failed', `${meta.kindName(kind)} ${when} — ${e.message}`, 'warn');
        continue;
      }
      const media = []; let error = '';
      if (kind === 'ig') {
        if (mat) media.push({ r2_key: mat.r2_key, url: mediaUrl(origin, mat.r2_key), mime: mat.mime });
        else if (gen.card && renderReady(env) && mediaReady(env)) {
          try {
            const jpg = await renderJpeg(env, cardHtml({ ...gen.card, angle, service: service.name, handle: service.handle }), { width: 1080, height: 1350 });
            const key = `c/${service.id}/${id}.jpg`;
            await putMedia(env, key, jpg, 'image/jpeg');
            media.push({ r2_key: key, url: mediaUrl(origin, key), mime: 'image/jpeg' });
          } catch (e) { error = '카드 렌더 실패 — ' + String(e.message).slice(0, 120); }
        } else error = gen.card ? (renderReady(env) ? '미디어 저장소(MEDIA) 없음' : '카드 렌더 없음(BROWSER 바인딩) — 소재 이미지를 올려 주세요') : '이미지 없음';
      }
      const state = error ? 'review' : (settings.approval === 'auto' ? 'scheduled' : 'review');
      await d.prepare(`INSERT INTO posts (id,service_id,channel,angle,state,scheduled_at,hook,text,hashtags,card,alt,media,material_id,error,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, service.id, kind, angle, state, at, gen.hook, gen.text, gen.hashtags.join(' '), gen.card ? JSON.stringify(gen.card) : '', gen.alt || '', JSON.stringify(media), (mat && mat.id) || gen.material_id, error, t, t).run();
      const row = { id, channel: kind, angle, state, scheduled_at: at, hook: gen.hook };
      mine.push({ ...row, material_id: (mat && mat.id) || '' });
      made.push(row);
    }
  }
  await event(env, service.id, 'plan.made', `${made.length}개 역`);
  return made;
}

// ---------- 역 조작 ----------
export async function actPost(env, service, post, action, patch = {}) {
  const d = await db(env);
  const next = transition(post.state, action, { attempts: post.attempts });
  if (!next && action !== 'edit') throw Object.assign(new Error('bad_transition'), { status: 409, detail: `${post.state} → ${action}` });
  const sets = []; const vals = [];
  if (next) {
    sets.push('state=?'); vals.push(next);
    if (action === 'approve' || action === 'retry') { sets.push('error=?', 'container_id=?', 'attempts=?'); vals.push('', '', 0); } // 다시 시도는 처음부터 — 옛 컨테이너·횟수를 버린다
  }
  if (patch.text != null) { sets.push('text=?'); vals.push(clip(String(patch.text), post.channel === 'ig' ? LIMITS.igCaption : LIMITS.thText)); }
  if (patch.hook != null) { sets.push('hook=?'); vals.push(clip(String(patch.hook), LIMITS.hook)); }
  if (patch.hashtags != null && post.channel === 'ig') { sets.push('hashtags=?'); vals.push(cleanTags(patch.hashtags).join(' ')); }
  if (patch.scheduled_at != null) { const at = Number(patch.scheduled_at); if (!(at > 0)) throw Object.assign(new Error('bad_time'), { status: 400 }); sets.push('scheduled_at=?'); vals.push(at); }
  if (!sets.length) return post;
  sets.push('updated=?'); vals.push(nowMs(), post.id);
  await d.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  await event(env, service.id, 'post.' + action, `${meta.kindName(post.channel)} ${post.hook}`);
  return getPost(env, service.id, post.id);
}

// ---------- 게시 ----------
function igCaption(post) { const tags = String(post.hashtags || '').split(/\s+/).filter(Boolean).map((t) => '#' + t).join(' '); return tags ? `${post.text}\n\n${tags}` : post.text; }

async function setPost(env, id, fields) {
  const d = await db(env); const keys = Object.keys(fields);
  await d.prepare(`UPDATE posts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated=? WHERE id=?`).bind(...keys.map((k) => fields[k]), nowMs(), id).run();
}

// 예약 → 게시 중 점유. 조건부 UPDATE 라 두 틱이 겹쳐도 한쪽만 잡는다(잡은 쪽이 true).
export async function claimPost(env, postId, fromState = 'scheduled') {
  const d = await db(env);
  const r = await d.prepare("UPDATE posts SET state='publishing', updated=? WHERE id=? AND state=?").bind(nowMs(), postId, fromState).run();
  return !!(r.meta && r.meta.changes);
}

// 두 단계: 컨테이너 만들기(이번 틱) → 상태 확인 뒤 게시(다음 틱). 글만 있는 Threads 도 같다(Meta 권장 대기).
// 어떤 예외도 글에 적히고 기록에 남는다 — 조용히 고착되는 글은 없다.
export async function publishPost(env, post) {
  const kind = post.channel;
  let ch = null;
  try {
    ch = await channelWithToken(env, post.service_id, kind);
    if (!ch || ch.status !== 'linked') throw Object.assign(new Error(`${meta.kindName(kind)} 연결 없음`), { final: true });
    if (!post.container_id) {
      let params;
      if (kind === 'ig') {
        const m = post.media[0];
        if (!m) throw Object.assign(new Error('이미지 없음 — Instagram 은 이미지가 있어야 올라간다'), { final: true });
        params = { image_url: m.url, caption: igCaption(post) };
        if (post.alt) params.alt_text = post.alt;
      } else {
        const m = post.media[0];
        params = m ? { media_type: 'IMAGE', image_url: m.url, text: post.text } : { media_type: 'TEXT', text: post.text };
      }
      const containerId = await meta.createContainer(env, kind, ch.platform_id, ch.token, params);
      await setPost(env, post.id, { container_id: containerId, state: 'publishing', attempts: post.attempts + 1, error: '' });
      return 'publishing';
    }
    const st = await meta.containerStatus(env, kind, post.container_id, ch.token);
    if (st.status === 'ERROR' || st.status === 'EXPIRED' || st.error) throw new Error('컨테이너 오류 — ' + (st.error || st.status));
    if (st.status && !/FINISHED|PUBLISHED/.test(st.status)) {
      if (nowMs() - post.updated > 30 * 60e3) throw new Error('컨테이너가 30분째 준비되지 않음');
      return 'publishing';
    }
    const platformId = await meta.publishContainer(env, kind, ch.platform_id, ch.token, post.container_id);
    let permalink = '';
    try { permalink = (await meta.postInfo(env, kind, platformId, ch.token)).permalink; } catch { /* 링크는 나중에 */ }
    await setPost(env, post.id, { state: 'posted', platform_post_id: platformId, permalink, published_at: nowMs(), error: '' });
    await event(env, post.service_id, 'post.posted', `${meta.kindName(kind)} ${post.hook}`);
    return 'posted';
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    let final = 'failed';
    try {
      const tokenProblem = e instanceof meta.MetaError && e.tokenProblem;
      if (tokenProblem && ch) await markExpired(env, ch.id, post.service_id, kind, msg);
      const attempts = post.attempts + (post.container_id ? 0 : 1); // 컨테이너를 못 만든 시도도 한 번으로 센다
      const next = transition('publishing', 'fail', { attempts }) || 'failed';
      final = (tokenProblem || e.final) ? 'failed' : next;
      await setPost(env, post.id, { state: final, error: msg, attempts, container_id: '' }); // 다음 시도는 새 컨테이너로
      await event(env, post.service_id, final === 'failed' ? 'post.failed' : 'post.retry', `${meta.kindName(kind)} ${post.hook} — ${msg.slice(0, 160)}`, final === 'failed' ? 'bad' : 'warn');
    } catch (e2) {
      console.error('publishPost: 실패 기록도 실패', post.id, e2 && e2.message); // 마지막 보루 — 다음 틱이 다시 잡는다
    }
    return final;
  }
}

export async function publishDue(env, now = nowMs()) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM posts WHERE (state='scheduled' AND scheduled_at<=?) OR state='publishing' ORDER BY scheduled_at LIMIT 20").bind(now).all();
  const out = [];
  for (const r of results) {
    const post = rowPost(r);
    try {
      if (post.state === 'scheduled') {
        if (!isDue(post, now) || !(await claimPost(env, post.id))) continue; // 다른 틱이 먼저 잡았으면 건너뜀
        post.state = 'publishing';
      }
      out.push({ id: post.id, result: await publishPost(env, post) });
    } catch (e) {
      out.push({ id: post.id, result: 'error', message: String(e && e.message).slice(0, 160) });
      console.error('publishDue', post.id, e && e.stack || e);
    }
  }
  return out;
}

// ---------- 지표 · 요약 ----------
export async function collectMetrics(env, serviceId) {
  const d = await db(env);
  const since = nowMs() - 14 * DAY;
  const { results } = await d.prepare("SELECT * FROM posts WHERE service_id=? AND state='posted' AND published_at>=?").bind(serviceId, since).all();
  const chans = {};
  for (const kind of ['ig', 'th']) chans[kind] = await channelWithToken(env, serviceId, kind);
  const followers = {};
  for (const kind of ['ig', 'th']) {
    const ch = chans[kind]; if (!ch || ch.status !== 'linked') continue;
    try {
      const me = await meta.me(env, kind, ch.token);
      followers[kind] = me.followers;
      const m = J(ch.meta, {}); m.followers = me.followers; m.picture = me.picture || m.picture; m.bio = me.bio || m.bio;
      await d.prepare('UPDATE channels SET meta=?, username=?, updated=? WHERE id=?').bind(JSON.stringify(m), me.username || ch.username, nowMs(), ch.id).run();
    } catch (e) { if (e instanceof meta.MetaError && e.tokenProblem) await markExpired(env, ch.id, serviceId, kind, e.message); }
  }
  let n = 0;
  for (const r of results) {
    const post = rowPost(r); const ch = chans[post.channel]; if (!ch || ch.status !== 'linked' || !post.platform_post_id) continue;
    try {
      const info = await meta.postInfo(env, post.channel, post.platform_post_id, ch.token);
      let ins = {};
      try { ins = await meta.postInsights(env, post.channel, post.platform_post_id, ch.token); } catch { /* 인사이트 권한 없으면 기본만 */ }
      const metrics = { ...post.metrics, likes: ins.likes ?? info.likes, comments: ins.comments ?? ins.replies ?? info.comments, reach: ins.reach ?? null, views: ins.views ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null, at: nowMs() };
      await d.prepare('UPDATE posts SET metrics=?, permalink=COALESCE(NULLIF(?, \'\'), permalink), updated=? WHERE id=?').bind(JSON.stringify(metrics), info.permalink || '', nowMs(), post.id).run();
      n++;
    } catch (e) { await event(env, serviceId, 'metrics.failed', `${post.hook} — ${String(e.message).slice(0, 120)}`, 'warn'); }
  }
  return { posts: n, followers };
}

export async function dailySummary(env, serviceId, { day = dayKey(nowMs() - DAY), origin = '' } = {}) {
  const d = await db(env);
  const service = rowService(await d.prepare('SELECT * FROM services WHERE id=?').bind(serviceId).first());
  if (!service) return null;
  const { followers } = await collectMetrics(env, serviceId);
  const dayStartMs = (() => { const [y, m, dd] = day.split('-').map(Number); return Date.UTC(y, m - 1, dd) - 9 * 3600e3; })();
  const posts = await postsOf(env, serviceId, dayStartMs, dayStartMs + DAY);
  const prev = await d.prepare('SELECT data FROM daily WHERE service_id=? AND day<? ORDER BY day DESC LIMIT 1').bind(serviceId, day).first();
  const prevF = prev ? (J(prev.data, {}).followers || {}) : {};
  const stats = {
    posted: posts.filter((p) => p.state === 'posted').length,
    failed: posts.filter((p) => p.state === 'failed').length,
    skipped: posts.filter((p) => p.state === 'skipped').length,
    followers,
    delta: { ig: followers.ig != null && prevF.ig != null ? followers.ig - prevF.ig : null, th: followers.th != null && prevF.th != null ? followers.th - prevF.th : null },
    engagement: posts.filter((p) => p.state === 'posted').reduce((a, p) => a + (p.metrics.likes || 0) + (p.metrics.comments || 0), 0),
  };
  let text = null;
  if (aiReady(env)) {
    try {
      const p = summaryPrompt({ service, day, stats, posts: posts.map((pp) => ({ ch: pp.channel, state: pp.state, hook: pp.hook, likes: pp.metrics.likes, comments: pp.metrics.comments, reach: pp.metrics.reach })) });
      text = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'summary' });
    } catch (e) { text = { headline: '요약 실패', lines: [String(e.message).slice(0, 100)], next: '' }; await event(env, serviceId, 'daily.failed', String(e.message).slice(0, 160), 'warn'); }
  }
  const data = { stats, text, made: nowMs() };
  await d.prepare('INSERT INTO daily (service_id, day, data) VALUES (?,?,?) ON CONFLICT(service_id, day) DO UPDATE SET data=excluded.data').bind(serviceId, day, JSON.stringify(data)).run();
  await event(env, serviceId, 'daily.made', day);
  return { day, ...data };
}

export async function allServiceIds(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT id FROM services').all();
  return results.map((r) => r.id);
}
