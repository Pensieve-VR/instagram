// Meta 공식 API — Instagram(Instagram 로그인 방식)과 Threads. 둘 다 "컨테이너 만들기 → 게시" 두 단계.
// 비공식 자동화는 쓰지 않는다. 한도: Instagram 하루 100건 · Threads 하루 250건(API 게시 기준).

const IG = {
  auth: 'https://www.instagram.com/oauth/authorize',
  token: 'https://api.instagram.com/oauth/access_token',
  host: 'https://graph.instagram.com',
  scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_insights'],
  exchange: 'ig_exchange_token', refresh: 'ig_refresh_token',
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

export function appCreds(env, kind) {
  return kind === 'ig'
    ? { id: env.IG_APP_ID || '', secret: env.IG_APP_SECRET || '' }
    : { id: env.THREADS_APP_ID || '', secret: env.THREADS_APP_SECRET || '' };
}
export const appReady = (env, kind) => { const c = appCreds(env, kind); return !!(c.id && c.secret); };

function version(env, kind) { return kind === 'ig' ? (env.GRAPH_VERSION || 'v23.0') : 'v1.0'; }
export function base(env, kind) { return `${KINDS[kind].host}/${version(env, kind)}`; }

export function authUrl(env, kind, redirectUri, state) {
  const K = KINDS[kind]; const c = appCreds(env, kind);
  const scopes = String(env[kind === 'ig' ? 'IG_SCOPES' : 'THREADS_SCOPES'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const u = new URL(K.auth);
  u.searchParams.set('client_id', c.id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (scopes.length ? scopes : K.scopes).join(','));
  u.searchParams.set('state', state);
  if (kind === 'ig') u.searchParams.set('force_reauth', 'true');
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
  const data = await post(K.token, { client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: stripCode(code) });
  const d = Array.isArray(data.data) ? data.data[0] : data; // Instagram 은 data 배열로 준다
  if (!d || !d.access_token) throw new MetaError('토큰 응답에 access_token 이 없다');
  return { token: d.access_token, userId: String(d.user_id || ''), permissions: d.permissions || [] };
}
export async function longLived(env, kind, shortToken) {
  const K = KINDS[kind]; const c = appCreds(env, kind);
  const d = await get(`${K.host}/access_token`, { grant_type: K.exchange, client_secret: c.secret, access_token: shortToken });
  return { token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 60 * 86400) * 1000 };
}
export async function refresh(env, kind, token) {
  const K = KINDS[kind];
  const d = await get(`${K.host}/refresh_access_token`, { grant_type: K.refresh, access_token: token });
  return { token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 60 * 86400) * 1000 };
}

export async function me(env, kind, token) {
  const fields = kind === 'ig'
    ? 'user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography'
    : 'id,username,name,threads_profile_picture_url,threads_biography';
  const d = await get(`${base(env, kind)}/me`, { fields, access_token: token });
  return {
    id: String(kind === 'ig' ? (d.user_id || d.id) : d.id),
    username: d.username || '',
    name: d.name || '',
    picture: d.profile_picture_url || d.threads_profile_picture_url || '',
    followers: Number(d.followers_count) || null,
    bio: d.biography || d.threads_biography || '',
  };
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
