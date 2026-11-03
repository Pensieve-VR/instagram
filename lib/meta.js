// Meta 공식 API — Instagram(Unified login)과 Threads. 둘 다 "컨테이너 만들기 → 게시" 두 단계.
// 비공식 자동화는 쓰지 않는다. 한도: Instagram 하루 100건 · Threads 하루 250건(API 게시 기준).
//
// Instagram: 2026-10 이후 새 Meta 앱은 "API setup with Instagram login" 을 쓸 수 없고 Unified login 만 된다.
//   로그인 = Facebook 로그인 대화상자 + config_id(앱 대시보드에서 만든 구성) · 권한은 구성에 들어 있어 scope 를 보내지 않는다
//   토큰 = 비즈니스 통합 시스템 사용자 토큰(만료는 구성에 따라 — 없으면 0) · 호스트 graph.facebook.com
//   /me 는 시스템 사용자라서 Instagram 계정 ID 는 /me/assigned_instagram_accounts 로 찾는다
const IG = {
  auth: 'https://www.facebook.com/dialog/oauth',
  host: 'https://graph.facebook.com',
  unified: true,
};
const TH = {
  auth: 'https://threads.com/oauth/authorize',
  token: 'https://graph.threads.com/oauth/access_token',
  host: 'https://graph.threads.com',
  scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_insights', 'threads_manage_replies', 'threads_read_replies'],
  exchange: 'th_exchange_token', refresh: 'th_refresh_token',
};
export const KINDS = { ig: IG, th: TH };
export const kindName = (k) => (k === 'ig' ? 'Instagram' : 'Threads');

// Instagram 은 Meta 앱 ID·시크릿(IG_APP_ID·IG_APP_SECRET) + 구성 ID(IG_CONFIG_ID, 비밀 아님) 셋 다 있어야 한다
export function appCreds(env, kind) {
  return kind === 'ig'
    ? { id: env.IG_APP_ID || '', secret: env.IG_APP_SECRET || '', config: env.IG_CONFIG_ID || '' }
    : { id: env.THREADS_APP_ID || '', secret: env.THREADS_APP_SECRET || '' };
}
export const appReady = (env, kind) => { const c = appCreds(env, kind); return !!(c.id && c.secret && (kind !== 'ig' || c.config)); };
// 시스템 사용자 토큰은 갱신 호출이 없다 — Threads 만 60일 토큰을 늘린다
export const refreshable = (kind) => kind === 'th';

function version(env, kind) { return kind === 'ig' ? (env.GRAPH_VERSION || 'v26.0') : 'v1.0'; }
export function base(env, kind) { return `${KINDS[kind].host}/${version(env, kind)}`; }

export function authUrl(env, kind, redirectUri, state) {
  const K = KINDS[kind]; const c = appCreds(env, kind);
  const u = new URL(K.auth);
  u.searchParams.set('client_id', c.id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  if (kind === 'ig') {
    u.searchParams.set('config_id', c.config);
    u.searchParams.set('display', 'page');
    u.searchParams.set('prompt', 'login'); // Facebook·Instagram 로그인 둘 다 보인다 — 운영 계정(Instagram)으로 바로 들어갈 수 있게
  } else {
    const scopes = String(env.THREADS_SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean);
    u.searchParams.set('scope', (scopes.length ? scopes : K.scopes).join(','));
  }
  return u.toString();
}

// Graph 오류 → 사람이 읽을 메시지. 토큰 문제(190)는 따로 표시해 채널을 '만료'로 돌린다.
export class MetaError extends Error {
  constructor(message, { status = 0, code = 0, subcode = 0, type = '' } = {}) {
    super(message); this.name = 'MetaError'; this.status = status; this.code = code; this.subcode = subcode; this.type = type;
  }
  get tokenProblem() { return this.code === 190 || /OAuthException/i.test(this.type) && /token|session/i.test(this.message); }
  get rateLimited() { return this.code === 4 || this.code === 17 || this.code === 32 || this.code === 613 || this.status === 429; }
}
async function parse(r) {
  let data = null; let text = '';
  try { text = await r.text(); data = JSON.parse(text); } catch { data = null; }
  if (!r.ok || (data && data.error)) {
    const e = (data && data.error) || {};
    throw new MetaError(String(e.message || e.error_message || text || r.statusText).slice(0, 300), { status: r.status, code: Number(e.code), subcode: Number(e.error_subcode), type: e.type || e.error_type || '' });
  }
  return data;
}
async function get(url, params) {
  const u = new URL(url); Object.entries(params).forEach(([k, v]) => v != null && u.searchParams.set(k, String(v)));
  return parse(await fetch(u, { headers: { accept: 'application/json' } }));
}
async function post(url, params) {
  const body = new URLSearchParams(); Object.entries(params).forEach(([k, v]) => v != null && body.set(k, String(v)));
  return parse(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }));
}

export const stripCode = (code) => String(code || '').replace(/#_$/, '');

export async function exchangeCode(env, kind, redirectUri, code) {
  const K = KINDS[kind]; const c = appCreds(env, kind);
  if (kind === 'ig') {
    // Unified login — Meta 앱 ID·시크릿으로 graph.facebook.com 에서 바꾼다(서버에서만)
    const d = await get(`${base(env, 'ig')}/oauth/access_token`, { client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri, code: stripCode(code) });
    if (!d || !d.access_token) throw new MetaError('토큰 응답에 access_token 이 없다');
    return { token: d.access_token, userId: '', expiresAt: Number(d.expires_in) > 0 ? Date.now() + Number(d.expires_in) * 1000 : 0 };
  }
  const data = await post(K.token, { client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: stripCode(code) });
  const d = Array.isArray(data.data) ? data.data[0] : data;
  if (!d || !d.access_token) throw new MetaError('토큰 응답에 access_token 이 없다');
  return { token: d.access_token, userId: String(d.user_id || ''), expiresAt: 0 };
}
// 짧은 토큰 → 오래가는 토큰. Instagram(시스템 사용자 토큰)은 바꿀 것이 없어 받은 그대로 둔다
export async function longLived(env, kind, short) {
  if (kind === 'ig') return { token: short.token, expiresAt: short.expiresAt || 0 };
  const K = KINDS[kind]; const c = appCreds(env, kind);
  const d = await get(`${K.host}/access_token`, { grant_type: K.exchange, client_secret: c.secret, access_token: short.token });
  return { token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 60 * 86400) * 1000 };
}
export async function refresh(env, kind, token) {
  if (!refreshable(kind)) throw new MetaError('이 토큰은 갱신할 수 없다 — 다시 연결');
  const K = KINDS[kind];
  const d = await get(`${K.host}/refresh_access_token`, { grant_type: K.refresh, access_token: token });
  return { token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 60 * 86400) * 1000 };
}

// Unified login 토큰이 다룰 수 있는 Instagram 계정들
export async function igAccounts(env, token) {
  const d = await get(`${base(env, 'ig')}/me/assigned_instagram_accounts`, { fields: 'id,username', access_token: token });
  return (d.data || []).map((a) => ({ id: String(a.id), username: a.username || '' }));
}
// 여럿이면 서비스의 사용자 이름과 같은 계정, 없으면 첫 계정
export function pickAccount(accounts, handle) {
  const h = String(handle || '').toLowerCase();
  return accounts.find((a) => a.username.toLowerCase() === h) || accounts[0] || null;
}

// 프로필 — Instagram 은 계정 ID(igId)로 묻는다(Unified login 의 /me 는 시스템 사용자다)
export async function me(env, kind, token, igId = '') {
  if (kind === 'ig') {
    if (!igId) throw new MetaError('Instagram 계정 ID 가 없다');
    const d = await get(`${base(env, 'ig')}/${igId}`, { fields: 'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography', access_token: token });
    return { id: String(d.id || igId), username: d.username || '', name: d.name || '', picture: d.profile_picture_url || '', followers: Number(d.followers_count) || null, bio: d.biography || '' };
  }
  const d = await get(`${base(env, kind)}/me`, { fields: 'id,username,name,threads_profile_picture_url,threads_biography', access_token: token });
  return { id: String(d.id), username: d.username || '', name: d.name || '', picture: d.threads_profile_picture_url || '', followers: null, bio: d.threads_biography || '' };
}

// 앱 해제·데이터 삭제 콜백의 signed_request — "서명.본문"(base64url), HMAC-SHA256(본문, 앱 시크릿)
export async function parseSignedRequest(secret, signed) {
  const [sig, body] = String(signed || '').split('.');
  if (!sig || !body || !secret) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', key, b64uBytes(sig), new TextEncoder().encode(body)); } catch { ok = false; }
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64uBytes(body))); } catch { return null; }
}
function b64uBytes(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
}

// 컨테이너 — Instagram: image_url/caption (JPEG 공개 URL) · Threads: media_type TEXT|IMAGE + text/image_url
export async function createContainer(env, kind, userId, token, params) {
  const path = kind === 'ig' ? 'media' : 'threads';
  const d = await post(`${base(env, kind)}/${userId}/${path}`, { ...params, access_token: token });
  return String(d.id);
}
export async function containerStatus(env, kind, containerId, token) {
  const fields = kind === 'ig' ? 'status_code,status' : 'status,error_message';
  const d = await get(`${base(env, kind)}/${containerId}`, { fields, access_token: token });
  const status = String(d.status_code || d.status || '').toUpperCase();
  return { status, error: d.error_message || (typeof d.status === 'string' && /error/i.test(d.status) ? d.status : '') };
}
export async function publishContainer(env, kind, userId, token, creationId) {
  const path = kind === 'ig' ? 'media_publish' : 'threads_publish';
  const d = await post(`${base(env, kind)}/${userId}/${path}`, { creation_id: creationId, access_token: token });
  return String(d.id);
}
export async function postInfo(env, kind, postId, token) {
  const fields = kind === 'ig' ? 'id,permalink,like_count,comments_count,timestamp' : 'id,permalink,timestamp,text';
  const d = await get(`${base(env, kind)}/${postId}`, { fields, access_token: token });
  return { permalink: d.permalink || '', likes: Number(d.like_count) || 0, comments: Number(d.comments_count) || 0 };
}
export async function postInsights(env, kind, postId, token) {
  const metric = kind === 'ig' ? 'reach,saved,likes,comments,shares,views' : 'views,likes,replies,reposts,quotes,shares';
  const d = await get(`${base(env, kind)}/${postId}/insights`, { metric, access_token: token });
  const out = {};
  for (const m of d.data || []) {
    const v = m.values && m.values[0] ? m.values[0].value : m.total_value && m.total_value.value;
    out[m.name] = Number(v) || 0;
  }
  return out;
}
export async function publishingLimit(env, kind, userId, token) {
  const path = kind === 'ig' ? 'content_publishing_limit' : 'threads_publishing_limit';
  const fields = kind === 'ig' ? 'quota_usage,config' : 'quota_usage,config';
  const d = await get(`${base(env, kind)}/${userId}/${path}`, { fields, access_token: token });
  const row = (d.data && d.data[0]) || {};
  return { used: Number(row.quota_usage) || 0, total: Number(row.config && row.config.quota_total) || (kind === 'ig' ? 100 : 250) };
}
