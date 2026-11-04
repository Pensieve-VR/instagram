// Claude 지시문 — 글감 하나 → 계정마다 게시물(만들기) · 한 마디로 고치기. 답은 JSON 하나.
import { FORMATS, LIMITS, PLATFORM_NAME } from './plan.js';

export const CARD_KINDS = ['cover', 'photo', 'chat', 'list', 'end'];

const CARD_GUIDE = `카드(르네 디자인 틀) — slides 에 {"card":{...}} 로 넣으면 1080×1350 이미지로 찍힌다:
- {"t":"cover","kicker":"작은 머리말(8자)","title":"큰 제목 — 한 줄 9자 안팎, 줄바꿈은 \\n, 최대 3줄","sub":"부제 한두 줄(40자)","photo":"소재 ID(선택)"}
- {"t":"photo","photo":"소재 ID(사진)","title":"사진 위 짧은 말(16자)","sub":"(선택)"}
- {"t":"chat","title":"(선택) 위 제목","lines":[{"who":"me","text":"사람 말"},{"who":"rene","text":"르네 말"}]}  — 2~4줄, 줄마다 30자 안
- {"t":"list","title":"제목(14자)","items":["항목 3개, 각 18자 안"]}
- {"t":"end","title":"마지막 한 줄(16자)","kw":"댓글 키워드","note":"키워드를 남기면 무엇을 주는지(30자)"}
소재 사진을 그대로 쓰려면 {"asset":"소재 ID"}.`;

function formatsText(platform) {
  return Object.entries(FORMATS[platform] || {}).map(([k, f]) => {
    const n = f.max === 0 ? '미디어 없음' : f.min === f.max ? `${f.min}장` : `${f.min}~${f.max}장`;
    const kinds = f.max === 0 ? '' : f.img && f.vid ? '사진·영상' : f.vid ? '영상만' : '사진만';
    return `${k}(${f.label}: ${n}${kinds ? ' · ' + kinds : ''})`;
  }).join(', ');
}

function brandText(b) {
  return `[브랜드 시트 — 여기 적힌 사실만 쓴다. 없는 숫자·날짜·약속·기능은 지어내지 않는다]
이름: ${b.name}
한 줄: ${b.oneliner}
사실:
${b.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}
쓰지 않는 말: ${b.banned.join(' · ') || '없음'}
말투: ${b.tone}
댓글 키워드: 한국어 「${b.kw.ko}」 · 영어 「${b.kw.en}」
링크(Instagram 은 글 속 링크가 눌리지 않으니 「프로필 링크」로만 말한다): ${b.link}
기본 해시태그: 한국어 ${b.tags.ko.map((t) => '#' + t).join(' ')} · 영어 ${b.tags.en.map((t) => '#' + t).join(' ')}`;
}

function assetsText(assets) {
  if (!assets.length) return '[소재] 없음 — 카드만 쓴다';
  return `[소재 — 붙인 그림은 이 순서다]\n${assets.map((a, i) => `${i + 1}. ${a.id} · ${a.kind === 'video' ? '영상' : '사진'} · ${a.title || '이름 없음'}`).join('\n')}`;
}

const SYSTEM = `너는 르네(René)의 소셜 콘텐츠 에디터다. 르네는 책상 위의 작은 AI 펫(하드웨어+소프트웨어)이다.
목표: 글감 하나로 계정마다 그 플랫폼·언어에 맞는 게시물을 만든다. 같은 글감이라도 계정마다 첫 줄(후킹)과 구성을 다르게.
원칙:
- 첫 줄이 전부다. 스크롤을 멈추게 하는 구체적인 장면·질문·반전으로 시작한다. 뻔한 「소개합니다」 금지.
- 고객 여정: 공감(문제 장면) → 르네가 하는 일 하나 → 다음 행동(댓글 키워드·프로필 링크). 한 게시물에 강조점은 하나.
- 영어 계정은 번역이 아니라 영어 화자가 쓴 것처럼 새로 쓴다. 영어 계정에는 가격을 쓰지 않는다.
- Instagram: 캐러셀은 3~7장(첫 장 cover, 끝 장 end 권장). 캡션 첫 줄 40자 안, 전체 600자 안. 해시태그 5~10개(hashtags 배열, # 없이).
- 릴스는 영상 소재가 있을 때만(slides=[{"asset":"영상 ID"}], cover=사진 소재 ID 선택). 스토리는 1장.
- Threads: 글 ${LIMITS.caption.th}자 안, 말하듯 짧게. 사진이 있으면 실제 사진 소재를 우선. 첫 댓글(first_reply)에 행동 유도 한 줄(링크 가능).
- X: ${LIMITS.caption.x}자 안.
- 소재 ID 는 주어진 것만 쓴다. 카드 글자는 짧게 — 카드에 문단을 넣지 않는다.
${CARD_GUIDE}`;

const POST_SHAPE = `{"account":"계정 ID","format":"형식","title":"역 이름 — 이 게시물의 첫 줄 요약(16자)","caption":"올릴 글(해시태그 제외)","hashtags":["Instagram 만"],"first_reply":"첫 댓글(없으면 빈 문자열)","alt":"첫 장 대체 텍스트(80자)","slides":[{"card":{...}}|{"asset":"ID"}],"cover":"릴스 커버 사진 ID 또는 빈 문자열"}`;

// accounts=[{id,platform,lang,username}], assets=[{id,kind,title}], recent=[{account_id,title}]
export function makePrompt({ brand, text, accounts, assets, recent }) {
  const acc = accounts.map((a) => `- ${a.id} · ${PLATFORM_NAME[a.platform]} · ${a.lang === 'en' ? '영어' : '한국어'}${a.username ? ' · @' + a.username : ''} · 형식: ${formatsText(a.platform)}`).join('\n');
  const rec = recent.length ? recent.map((r) => `- ${r.title}`).join('\n') : '없음';
  const user = `${brandText(brand)}

[계정 — 각 계정에 게시물 하나씩]
${acc}

${assetsText(assets)}

[최근 글 — 겹치지 않게]
${rec}

[글감]
${text}

답 모양: {"title":"글감 이름(12자)","posts":[${POST_SHAPE}, …]}`;
  return { system: SYSTEM, user, maxTokens: 9000 };
}

export function revisePrompt({ brand, post, account, say, assets }) {
  const user = `${brandText(brand)}

[계정] ${account.id} · ${PLATFORM_NAME[account.platform]} · ${account.lang === 'en' ? '영어' : '한국어'} · 형식: ${formatsText(account.platform)}

${assetsText(assets)}

[지금 게시물]
${JSON.stringify(post)}

[고칠 말]
${say}

고칠 말만 반영하고 나머지는 그대로 둔다. 답 모양: ${POST_SHAPE}`;
  return { system: SYSTEM, user, maxTokens: 5000 };
}
