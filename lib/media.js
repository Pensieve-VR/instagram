// 공개 미디어 저장 — Workers KV(바인딩 MEDIA). 무료 요금제에 포함(카드 없이), 값 25MB 까지.
// Meta 는 /media/<key> 공개 URL 에서 이미지를 가져간다. KV 는 몇 초 늦게 퍼질 수 있어 게시는 다음 틱에 한다(이미 그렇게 돼 있다).
export const mediaReady = (env) => !!env.MEDIA;

export async function putMedia(env, key, bytes, contentType) {
  if (!env.MEDIA) throw Object.assign(new Error('no_media'), { status: 503 });
  await env.MEDIA.put(key, bytes, { metadata: { contentType, size: bytes.byteLength, at: Date.now() } });
}

export async function getMedia(env, key) {
  if (!env.MEDIA) return null;
  const { value, metadata } = await env.MEDIA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!value) return null;
  return { body: value, contentType: (metadata && metadata.contentType) || 'application/octet-stream' };
}

export async function deleteMedia(env, key) {
  if (!env.MEDIA || !key) return;
  try { await env.MEDIA.delete(key); } catch (e) { console.error('media delete', key, e && e.message); }
}

// 접두사로 전부 지우기(서비스 삭제 때). list 는 하루 1,000회 한도라 한 번에 많이 가져온다.
export async function deletePrefix(env, prefix) {
  if (!env.MEDIA) return 0;
  let cursor; let n = 0;
  do {
    const l = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const k of l.keys) { await env.MEDIA.delete(k.name); n++; }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return n;
}
