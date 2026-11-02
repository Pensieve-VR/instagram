// 운영 동작 — API 와 크론이 같이 쓴다. 생성·예약·게시·지표·요약.
import { db, event, J, rowPost, rowChannel, rowService } from './db.js';
import { ask, aiReady } from './ai.js';
import { candidatesPrompt, profilePrompt, materialPrompt, postPrompt, revisePrompt, summaryPrompt } from './prompts.js';
import * as meta from './meta.js';
import { seal, open } from './crypto.js';
import { cardHtml, renderJpeg, renderReady } from './render.js';
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

export async function genCandidates(env, service) {
  const p = candidatesPrompt(service);
  const out = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'candidates' });
  const list = (Array.isArray(out.candidates) ? out.candidates : []).map((c) => ({ handle: cleanHandle(c.handle), why: String(c.why || '').slice(0, 60) }))
    .filter((c) => validHandle(c.handle));
  const uniq = []; const seen = new Set();
  for (const c of list) { if (!seen.has(c.handle)) { seen.add(c.handle); uniq.push(c); } }
  // 비었는지 — Instagram 기준으로만 두드린다(Threads 는 Instagram 계정과 같은 이름을 쓴다)
  const checked = await Promise.all(uniq.slice(0, 6).map(async (c) => ({ ...c, free: env.MOCK_AI === '1' ? 'unknown' : await meta.handleFree('ig', c.handle) })));
  const d = await db(env);
  const oneliner = service.oneliner || String(out.oneliner || '').slice(0, 60);
  await d.prepare('UPDATE services SET candidates=?, oneliner=?, updated=? WHERE id=?').bind(JSON.stringify(checked), oneliner, nowMs(), service.id).run();
  return { candidates: checked, oneliner };
}

export async function pickHandle(env, service, handle) {
  const h = cleanHandle(handle);
  if (!validHandle(h)) throw Object.assign(new Error('bad_handle'), { status: 400 });
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

export async function genProfile(env, service) {
  const p = profilePrompt(service);
  const out = await ask(env, p.system, p.user, { maxTokens: p.maxTokens, mock: 'profile' });
  const bio = clip(String(out.bio || ''), 150);
  const profile = { bio, link_text: String(out.link_text || '').slice(0, 20), monogram: String(out.monogram || service.name.slice(0, 1)).slice(0, 2), palette: ['rose', 'navy', 'teal', 'ochre', 'violet'].includes(out.palette) ? out.palette : 'rose' };
  const d = await db(env);
  const settings = mergeSettings(service.settings); settings.profile = profile;
  await d.prepare('UPDATE services SET bio=?, settings=?, updated=? WHERE id=?').bind(bio, JSON.stringify(settings), nowMs(), service.id).run();
  await d.prepare('INSERT OR IGNORE INTO gates (service_id, kind, done) VALUES (?,?,0)').bind(service.id, 'profile').run();
  return profile;
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
    const taken = new Set(mine.map((p) => p.scheduled_at));
    const slots = nextSlots(settings[kind].slots, fromMs, until, taken);
    for (const at of slots) {
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
        else if (gen.card && renderReady(env)) {
          try {
            const jpg = await renderJpeg(env, cardHtml({ ...gen.card, angle, service: service.name, handle: service.handle }), { width: 1080, height: 1350 });
            const key = `c/${service.id}/${id}.jpg`;
            await env.MEDIA.put(key, jpg, { httpMetadata: { contentType: 'image/jpeg' } });
            media.push({ r2_key: key, url: mediaUrl(origin, key), mime: 'image/jpeg' });
          } catch (e) { error = '카드 렌더 실패 — ' + String(e.message).slice(0, 120); }
        } else error = gen.card ? '카드 렌더 없음(BROWSER 바인딩) — 소재 이미지를 올려 주세요' : '이미지 없음';
      }
      const state = error ? 'review' : (settings.approval === 'auto' ? 'scheduled' : 'review');
      await d.prepare(`INSERT INTO posts (id,service_id,channel,angle,state,scheduled_at,hook,text,hashtags,card,media,material_id,error,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, service.id, kind, angle, state, at, gen.hook, gen.text, gen.hashtags.join(' '), gen.card ? JSON.stringify(gen.card) : '', JSON.stringify(media), (mat && mat.id) || gen.material_id, error, t, t).run();
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
  if (next) { sets.push('state=?'); vals.push(next); if (action === 'approve' || action === 'retry') { sets.push('error=?'); vals.push(''); } }
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

export async function publishPost(env, post) {
  const ch = await channelWithToken(env, post.service_id, post.channel);
  if (!ch || ch.status !== 'linked') { await setPost(env, post.id, { state: 'failed', error: `${meta.kindName(post.channel)} 연결 없음` }); await event(env, post.service_id, 'post.failed', `${post.hook} — 연결 없음`, 'bad'); return 'failed'; }
  const kind = post.channel;
  try {
    if (!post.container_id) {
      let params;
      if (kind === 'ig') {
        const m = post.media[0];
        if (!m) throw new Error('이미지 없음 — Instagram 은 이미지가 있어야 올라간다');
        params = { image_url: m.url, caption: igCaption(post) };
        if (post.alt) params.alt_text = post.alt;
      } else {
        const m = post.media[0];
        params = m ? { media_type: 'IMAGE', image_url: m.url, text: post.text } : { media_type: 'TEXT', text: post.text };
      }
      const containerId = await meta.createContainer(env, kind, ch.platform_id, ch.token, params);
      await setPost(env, post.id, { container_id: containerId, state: 'publishing', attempts: post.attempts + 1 });
      post = { ...post, container_id: containerId, state: 'publishing', attempts: post.attempts + 1 };
      if (kind === 'th' && !post.media[0]) { /* 글만 있는 Threads 는 바로 게시 */ } else return 'publishing'; // 미디어는 다음 틱에 상태 확인 후 게시
    }
    if (post.media[0]) {
      const st = await meta.containerStatus(env, kind, post.container_id, ch.token);
      if (st.status === 'ERROR' || st.error) throw new Error('컨테이너 오류 — ' + (st.error || st.status));
      if (st.status && !/FINISHED|PUBLISHED/.test(st.status)) {
        if (nowMs() - post.updated > 30 * 60e3) throw new Error('컨테이너가 30분째 준비되지 않음');
        return 'publishing';
      }
    }
    const platformId = await meta.publishContainer(env, kind, ch.platform_id, ch.token, post.container_id);
    let permalink = '';
    try { permalink = (await meta.postInfo(env, kind, platformId, ch.token)).permalink; } catch { /* 링크는 나중에 */ }
    await setPost(env, post.id, { state: 'posted', platform_post_id: platformId, permalink, published_at: nowMs(), error: '' });
    await event(env, post.service_id, 'post.posted', `${meta.kindName(kind)} ${post.hook}`);
    return 'posted';
  } catch (e) {
    const tokenProblem = e instanceof meta.MetaError && e.tokenProblem;
    if (tokenProblem) await markExpired(env, ch.id, post.service_id, kind, e.message);
    const next = transition('publishing', 'fail', { attempts: post.attempts + (post.container_id ? 0 : 1) }) || 'failed';
    const final = tokenProblem ? 'failed' : next;
    await setPost(env, post.id, { state: final, error: String(e.message).slice(0, 300), container_id: final === 'failed' ? post.container_id : '' });
    await event(env, post.service_id, final === 'failed' ? 'post.failed' : 'post.retry', `${meta.kindName(kind)} ${post.hook} — ${String(e.message).slice(0, 160)}`, final === 'failed' ? 'bad' : 'warn');
    return final;
  }
}

export async function publishDue(env, now = nowMs()) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM posts WHERE (state='scheduled' AND scheduled_at<=?) OR state='publishing' ORDER BY scheduled_at LIMIT 20").bind(now).all();
  const out = [];
  for (const r of results) {
    const post = rowPost(r);
    if (post.state === 'scheduled' && !isDue(post, now)) continue;
    if (post.state === 'scheduled') { await setPost(env, post.id, { state: 'publishing' }); post.state = 'publishing'; }
    out.push({ id: post.id, result: await publishPost(env, post) });
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
    } catch (e) { text = { headline: '요약 실패', lines: [String(e.message).slice(0, 100)], next: '' }; }
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
