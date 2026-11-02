// 암호 로그인 — 운영자가 Cloudflare 비밀 PASSWORDS에 등록한 암호만 통과한다. (BM·브레인 스토밍과 같은 형식)
// PASSWORDS 형식: "이름=암호" 를 쉼표나 줄바꿈으로 여러 개. "암호"만 적어도 된다.
// 공간(space) = 이름에서 만든다 → 암호를 바꿔도 같은 이름이면 같은 공간(서비스·계정)이 열린다.
const enc = new TextEncoder();
const DAY = 86400;

export const b64u = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
export async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function entries(env) {
  return String(env.PASSWORDS || '')
    .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf('='); return i > 0 ? { name: s.slice(0, i).trim(), pw: s.slice(i + 1).trim() } : { name: '', pw: s }; })
    .filter((e) => e.pw);
}
export const configured = (env) => entries(env).length > 0;

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || 'instagram-session|' + String(env.PASSWORDS || '');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(env, payload) {
  return b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload)));
}
export async function verifySig(env, payload, sig) {
  try { return await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(payload)); } catch { return false; }
}

export async function login(env, password) {
  const pw = String(password || '');
  if (!pw) return null;
  const want = await sha('pw|' + pw);
  let hit = null;
  for (const e of entries(env)) {
    if ((await sha('pw|' + e.pw)) === want) { hit = e; break; }
  }
  if (!hit) return null;
  const space = hit.name ? 'u-' + (await sha('name|' + hit.name)).slice(0, 16) : 'p-' + want.slice(0, 16);
  const name = hit.name || '홍보실';
  const exp = Math.floor(Date.now() / 1000) + 30 * DAY;
  const payload = `${space}.${exp}.${b64u(enc.encode(name))}`;
  return { token: `${payload}.${await sign(env, payload)}`, space, name };
}

export async function verifyToken(env, token) {
  if (!configured(env)) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const [space, exp, nameB, sig] = parts;
  if (!/^[up]-[0-9a-f]{16}$/.test(space) || !(Number(exp) > Date.now() / 1000)) return null;
  if (!(await verifySig(env, `${space}.${exp}.${nameB}`, sig))) return null;
  let name = '';
  try { name = new TextDecoder().decode(unb64u(nameB)); } catch { name = ''; }
  return { space, name };
}

export async function verify(request, env) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return verifyToken(env, m[1]);
}

// OAuth 상태값 — 돌아올 때 어느 공간·서비스인지 알아야 하므로 서명해서 보낸다(10분).
export async function makeState(env, space, serviceId, kind) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(8)));
  const payload = `${space}.${serviceId}.${kind}.${exp}.${nonce}`;
  return `${payload}.${await sign(env, payload)}`;
}
export async function readState(env, state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 6) return null;
  const [space, serviceId, kind, exp, nonce, sig] = parts;
  if (!/^[up]-[0-9a-f]{16}$/.test(space) || !/^s[a-z0-9]{6,24}$/.test(serviceId) || !/^(ig|th)$/.test(kind)) return null;
  if (!(Number(exp) > Date.now() / 1000)) return null;
  if (!(await verifySig(env, `${space}.${serviceId}.${kind}.${exp}.${nonce}`, sig))) return null;
  return { space, serviceId, kind };
}

export const slow = () => new Promise((r) => setTimeout(r, 800)); // 틀린 암호는 늦게 답한다
