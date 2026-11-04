// Claude 호출(비스트리밍) → JSON. 키가 없거나 MOCK_AI=1 이면 정해진 틀로 답한다(흐름 확인용).
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export const aiReady = (env) => env.MOCK_AI === '1' || !!env.ANTHROPIC_API_KEY;

// 답 글에서 첫 JSON 값을 꺼낸다. 코드 울타리·앞뒤 말은 버린다. 못 꺼내면 구조화된 오류.
export function extractJson(text) {
  const s = String(text || '');
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) throw new Error('ai_no_json');
  const start = Math.min(...starts);
  const open = s[start]; const close = open === '{' ? '}' : ']';
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { if (ch !== close) throw new Error('ai_bad_json'); try { return JSON.parse(s.slice(start, i + 1)); } catch { throw new Error('ai_bad_json'); } } }
  }
  throw new Error('ai_unclosed_json');
}

async function failText(r) {
  let t = '';
  try { t = await r.text(); } catch { /* ignore */ }
  try { const j = JSON.parse(t); t = (j.error && (j.error.message || j.error.type)) || t; } catch { /* not json */ }
  return `${r.status} ${String(t).slice(0, 200)}`;
}

// Claude 5 세대는 thinking 칸이 없으면 적응형으로 먼저 생각한다. JSON 한 덩어리가 목적이라 생각은 끄고 노력만 조절한다.
export async function askClaude(env, system, user, { maxTokens = 2000, json = true } = {}) {
  const base = {
    model: env.CLAUDE_MODEL || DEFAULT_MODEL,
    system: system + (json ? '\n\n답은 반드시 JSON 하나만. 코드 울타리·설명 없이.' : ''),
    messages: [{ role: 'user', content: user }],
    max_tokens: maxTokens,
  };
  const tuned = { ...base, thinking: { type: env.CLAUDE_THINKING || 'between_tools' } };
  const effort = env.CLAUDE_EFFORT || 'medium';
  if (effort !== 'off') tuned.output_config = { effort };
  const send = (b) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
  let r = await send(tuned);
  if (r.status === 400) {
    const why = await failText(r);
    if (!/thinking|effort|output_config/i.test(why)) throw new Error('claude ' + why);
    r = await send({ ...base, max_tokens: maxTokens + 3000 });
  }
  if (!r.ok) throw new Error('claude ' + (await failText(r)));
  const data = await r.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (!text.trim()) throw new Error('claude empty');
  return json ? extractJson(text) : text;
}

export async function ask(env, system, user, opts = {}) {
  if (env.MOCK_AI === '1') return mock(opts.mock || 'generic', user, opts.mockCtx || {});
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('no_key'), { status: 503 });
  return askClaude(env, system, user, opts);
}

// 연습용 답 — 모양만 맞춘다(MOCK_AI=1). 실제 키가 있으면 쓰이지 않는다.
// make: ctx.accounts=[{id,platform,lang}], ctx.assets=[{id,kind}] · revise: ctx.post
export function mock(kind, user, ctx = {}) {
  switch (kind) {
    case 'make': {
      const text = String(ctx.text || '글감');
      const video = (ctx.assets || []).find((a) => a.kind === 'video');
      const photo = (ctx.assets || []).find((a) => a.kind === 'image');
      return {
        title: text.slice(0, 12),
        posts: (ctx.accounts || []).map((a) => {
          const en = a.lang === 'en';
          if (a.platform === 'ig' && video) return { account: a.id, format: 'reel', title: en ? 'Show it, it sees' : '보여 주면 본다', caption: en ? 'It sees what you show it.' : '보여 주면 봐요.', hashtags: en ? ['rene'] : ['르네'], slides: [{ asset: video.id }], cover: photo ? photo.id : '' };
          if (a.platform === 'ig') return { account: a.id, format: 'carousel', title: en ? 'Your own AI pet' : '나만의 AI 펫', caption: (en ? 'Practice caption — ' : '연습 캡션 — ') + text, hashtags: en ? ['rene', 'aipet'] : ['르네', 'AI펫'], first_reply: '', alt: '르네 카드',
            slides: [{ card: { t: 'cover', kicker: en ? 'rené.' : '르네', title: en ? 'AI got\na face.' : 'AI에게\n얼굴이 생겼다.', sub: text.slice(0, 40), photo: photo ? photo.id : '' } }, { card: { t: 'list', title: en ? 'What it does' : '르네가 하는 일', items: en ? ['Reads context', 'Sees with a camera', 'Works with Claude·Codex'] : ['맥락을 읽어요', '카메라로 보고 말해요', 'Claude·Codex와 이어져요'] } }, { card: { t: 'end', title: en ? 'Want one early?' : '먼저 만나 볼래요?', kw: en ? 'RENE' : '르네', note: en ? 'Comment and we DM the early-bird link' : '댓글 남기면 얼리버드 링크를 DM으로' } }] };
          if (a.platform === 'th') return { account: a.id, format: photo ? 'image' : 'text', title: en ? 'Tab hell' : '탭 지옥', caption: (en ? 'Practice thread — ' : '연습 스레드 — ') + text, first_reply: en ? 'Waitlist in bio' : '대기 명단은 프로필 링크', slides: photo ? [{ asset: photo.id }] : [] };
          return { account: a.id, format: 'text', title: 'X', caption: 'Practice post — ' + text, slides: [] };
        }),
      };
    }
    case 'revise': {
      const p = ctx.post || {};
      return { ...p, caption: '(고침) ' + String(p.caption || ''), title: String(p.title || '') };
    }
    default:
      return { ok: true };
  }
}
