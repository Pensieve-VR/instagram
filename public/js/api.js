// 서버와 말하기 — 열쇠는 브라우저에 둔다(BM·브레인 스토밍과 같은 방식).
const AUTH = 'rene.auth';
export const API = { token: '', name: '' };
try { Object.assign(API, JSON.parse(localStorage.getItem(AUTH) || '{}')); } catch { /* 무시 */ }
const saveAuth = () => { try { localStorage.setItem(AUTH, JSON.stringify({ token: API.token, name: API.name })); } catch { /* 무시 */ } };
export function clearAuth() { API.token = ''; API.name = ''; try { localStorage.removeItem(AUTH); } catch { /* 무시 */ } }
export const authed = () => !!API.token;

export class ApiError extends Error {
  constructor(status, body) { super((body && (body.error || body.message)) || `http_${status}`); this.status = status; this.body = body || {}; }
}
async function call(method, path, body) {
  const init = { method, headers: API.token ? { authorization: 'Bearer ' + API.token } : {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(path, init);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    if (r.status === 401 && path !== '/api/login') { clearAuth(); location.reload(); }
    throw new ApiError(r.status, data);
  }
  return data;
}
const P = (id) => `/api/posts/${id}`;
export const api = {
  health: () => call('GET', '/api/health'),
  async login(password) { const r = await call('POST', '/api/login', { password }); API.token = r.token; API.name = r.name; saveAuth(); return r; },
  state: (from, to) => call('GET', `/api/state?from=${from}&to=${to}`),
  events: () => call('GET', '/api/events'),
  make: (body) => call('POST', '/api/make', body),
  post: (id) => call('GET', P(id)),
  patch: (id, body) => call('POST', P(id), body),
  act: (id, action) => call('POST', P(id), { action }),
  revise: (id, say) => call('POST', P(id) + '/revise', { say }),
  render: (id) => call('POST', P(id) + '/render', {}),
  now: (id) => call('POST', P(id) + '/now', {}),
  delPost: (id) => call('DELETE', P(id)),
  async upload(file, meta = {}) { // 몸 = 파일 그대로, 이름 등은 머리로
    const headers = { authorization: 'Bearer ' + API.token, 'content-type': file.type || 'application/octet-stream' };
    for (const k of ['src', 'title', 'w', 'h']) if (meta[k] != null) headers['x-' + k] = encodeURIComponent(String(meta[k]));
    const r = await fetch('/api/assets', { method: 'POST', headers, body: file });
    let data = null; try { data = await r.json(); } catch { data = null; }
    if (!r.ok) { if (r.status === 401) { clearAuth(); location.reload(); } throw new ApiError(r.status, data); }
    return data;
  },
  delAsset: (id) => call('DELETE', `/api/assets/${id}`),
  importItems: (items) => call('POST', '/api/import', { items }),
  addLine: (body) => call('POST', '/api/accounts', body),
  patchLine: (id, body) => call('POST', `/api/accounts/${id}`, body),
  delLine: (id) => call('DELETE', `/api/accounts/${id}`),
  unlink: (id) => call('POST', `/api/accounts/${id}/unlink`, {}),
  igAvailable: () => call('GET', '/api/accounts/ig-available'),
  attachIg: (id, igId) => call('POST', `/api/accounts/${id}/attach-ig`, { ig_id: igId }),
  connect: (id) => call('GET', `/api/accounts/${id}/connect`),
  brand: () => call('GET', '/api/brand'),
  saveBrand: (b) => call('POST', '/api/brand', b),
  sync: () => call('POST', '/api/sync', {}),
};
