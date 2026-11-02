// 응답 도우미 · 우리 주소에서 온 요청만 받기 · 몸 읽기
export function err(status, error, extra = {}) {
  return Response.json({ error, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}
export const ok = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// 우리 주소에서 온 요청만 받는다 — 남의 사이트가 운영자 키로 AI·Meta를 부르지 못하게.
export function originOk(request, env) {
  const o = request.headers.get('origin');
  if (!o) return false;
  let u;
  try { u = new URL(o); } catch { return false; }
  const h = u.hostname;
  if (h === 'instagram.pensieve.kr') return true;
  if (h === 'pensieve-instagram.pensieve.workers.dev' || /(^|\.)pensieve-instagram\.[^.]+\.workers\.dev$/.test(h)) return true;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  try { if (env.PUBLIC_ORIGIN && new URL(env.PUBLIC_ORIGIN).origin === u.origin) return true; } catch { /* 설정 오류 */ }
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return extra.includes(u.origin);
}

export async function readJson(request, limit = 200000) {
  if ((Number(request.headers.get('content-length')) || 0) > limit) return { error: 'too_large' };
  try { const j = await request.json(); return (j && typeof j === 'object') ? { body: j } : { error: 'bad_request' }; } catch { return { error: 'bad_request' }; }
}

// 공개 주소 — Meta가 미디어를 가져갈 때와 OAuth 되돌아올 주소에 쓴다
export function publicOrigin(request, env) {
  if (env.PUBLIC_ORIGIN && !/localhost|127\.0\.0\.1/.test(request.headers.get('host') || '')) return env.PUBLIC_ORIGIN.replace(/\/$/, '');
  return new URL(request.url).origin;
}

export const now = () => Date.now();
export const idFor = (prefix) => prefix + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => (b % 36).toString(36)).join('');
