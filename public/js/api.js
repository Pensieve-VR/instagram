// 서버와 말하기 — 열쇠는 브라우저에 둔다(BM·브레인 스토밍과 같은 방식).
const AUTH = 'hongbo.auth';
export const API = { token: '', space: '', name: '' };
try { Object.assign(API, JSON.parse(localStorage.getItem(AUTH) || '{}')); } catch { /* 무시 */ }

function saveAuth() { try { localStorage.setItem(AUTH, JSON.stringify({ token: API.token, space: API.space, name: API.name })); } catch { /* 무시 */ } }
export function clearAuth() { API.token = ''; API.space = ''; API.name = ''; try { localStorage.removeItem(AUTH); } catch { /* 무시 */ } }
export const authed = () => !!API.token;
const headers = (extra = {}) => ({ ...(API.token ? { authorization: 'Bearer ' + API.token } : {}), ...extra });

export class ApiError extends Error {
  constructor(status, body) { super((body && (body.error || body.message)) || `http_${status}`); this.status = status; this.body = body || {}; }
}

async function call(method, path, body, opts = {}) {
  const init = { method, headers: headers(opts.headers) };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(path, init);
  if (opts.raw) return r;
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    if (r.status === 401 && path !== '/api/login') { clearAuth(); location.reload(); }
    throw new ApiError(r.status, data);
  }
  return data;
}

export const api = {
  health: () => call('GET', '/api/health'),
  async login(password) {
    const r = await call('POST', '/api/login', { password });
    API.token = r.token; API.space = r.space; API.name = r.name; saveAuth();
    return r;
  },
  state: (service) => call('GET', '/api/state' + (service ? `?service=${encodeURIComponent(service)}` : '')),
  createService: (body) => call('POST', '/api/services', body),
  deleteService: (id) => call('DELETE', `/api/services/${id}`),
  candidates: (id) => call('POST', `/api/services/${id}/candidates`),
  handle: (id, handle) => call('POST', `/api/services/${id}/handle`, { handle }),
  gate: (id, kind, done) => call('POST', `/api/services/${id}/gates/${kind}`, { done }),
  profile: (id) => call('POST', `/api/services/${id}/profile`),
  brief: (id, body) => call('POST', `/api/services/${id}/brief`, body),
  settings: (id, body) => call('POST', `/api/services/${id}/settings`, body),
  oauthStart: (id, kind) => call('GET', `/api/oauth/${kind}/start?service=${encodeURIComponent(id)}`),
  addMaterial: (id, body) => call('POST', `/api/services/${id}/materials`, body),
  deleteMaterial: (id, mid) => call('DELETE', `/api/services/${id}/materials/${mid}`),
  plan: (id, body) => call('POST', `/api/services/${id}/plan`, body || {}),
  post: (id, pid, body) => call('POST', `/api/services/${id}/posts/${pid}`, body),
  postNow: (id, pid) => call('POST', `/api/services/${id}/posts/${pid}/now`, {}),
  regenerate: (id, pid) => call('POST', `/api/services/${id}/posts/${pid}/regenerate`, {}),
  sync: (id) => call('POST', `/api/services/${id}/sync`, {}),
  events: (id) => call('GET', `/api/services/${id}/events`),
  // 이미지는 열쇠가 필요해 blob 으로 받는다
  async blob(path) { const r = await call('GET', path, undefined, { raw: true }); if (!r.ok) throw new ApiError(r.status, null); return r.blob(); },
};
