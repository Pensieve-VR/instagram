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
  if (env.MOCK_AI === '1') return mock(opts.mock || 'generic', user);
  if (!env.ANTHROPIC_API_KEY) throw new Error('no_key');
  return askClaude(env, system, user, opts);
}

// 연습용 답 — 모양만 맞춘다. 실제 키가 있으면 쓰이지 않는다.
export function mock(kind, user) {
  const name = (String(user).match(/서비스 이름:\s*([^\n]+)/) || [])[1] || '서비스';
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'pensieve';
  switch (kind) {
    case 'candidates':
      return { candidates: [`${base}.kr`, `${base}.official`, `hello.${base}`, `${base}_app`, `${base}.team`].map((h, i) => ({ handle: h, why: ['짧고 기억하기 쉬움', '공식 느낌', '친근함', '앱임을 드러냄', '팀 계정 느낌'][i] })), oneliner: `${name} — 한 줄 소개(연습)` };
    case 'profile':
      return { bio: `${name} · 한 줄 소개(연습)\n무엇을 어떻게 돕는지 두 번째 줄\n↓ 자세히`, link_text: '자세히 보기', monogram: name.slice(0, 1).toUpperCase() };
    case 'material':
      return { title: '소재 요약(연습)', summary: '핵심 문장 1 · 핵심 문장 2 · 수치 하나(출처: 연습)', facts: ['사실 1', '사실 2'], numbers: [] };
    case 'post':
      return { hook: `${name}, 오늘 하나만`, text: `${name}의 기능 하나를 짧게 설명하는 연습 글입니다.\n\n두 번째 문단.`, hashtags: ['펜시브', '연습'], card: { headline: '기능 하나', sub: '그 기능이 바꾸는 순간', bullets: ['첫째', '둘째', '셋째'] }, alt: '카드 이미지: 기능 하나' };
    case 'revise':
      return { hook: `${name}, 오늘 하나만(다듬음)`, text: `${name}의 기능 하나를 더 짧고 또렷하게 설명하는 글.\n\n두 번째 문단.`, hashtags: ['펜시브', '연습'], card: { headline: '기능 하나', sub: '그 기능이 바꾸는 순간', bullets: ['첫째', '둘째'] }, alt: '카드 이미지: 기능 하나', changed: '문장 길이를 줄임' };
    case 'summary':
      return { headline: '어제는 조용했다', lines: ['게시 1 · 도달 작음', '팔로워 변화 없음'], next: '이번 주 두 번째 글은 질문형으로' };
    default:
      return { ok: true };
  }
}
