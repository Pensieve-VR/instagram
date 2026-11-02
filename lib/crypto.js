// Meta 토큰 보관용 봉인 — AES-GCM. 열쇠는 SESSION_SECRET(없으면 PASSWORDS)에서 만든다.
import { b64u, unb64u } from './auth.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const sealReady = (env) => String(env.SESSION_SECRET || '').length >= 16;
async function key(env) {
  if (!sealReady(env)) throw Object.assign(new Error('no_secret'), { status: 503 }); // 암호를 바꿔도 토큰이 살아 있으려면 고정 비밀이 있어야 한다
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('instagram-token|' + env.SESSION_SECRET));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(String(text)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return b64u(out);
}

export async function open(env, blob) {
  if (!blob) return '';
  const bytes = unb64u(blob);
  if (bytes.length < 13) throw new Error('sealed_too_short');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(env), bytes.slice(12));
  return dec.decode(pt);
}
