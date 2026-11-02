# 홍보실 — instagram.pensieve.kr

펜시브 서비스의 Instagram·Threads 계정을 개설부터 게시·감시까지 맡아 돌리는 운영 도구. 공식 Meta API만 쓴다.

- 기획안: [docs/기획안.html](docs/기획안.html) — 결론 · 흐름 · 운영 규칙 · 구조 · 단계 · 화면 · 디자인 시스템 · 결정됨 · 구현 현황
- 맨 처음 **암호** → 내 공간이 열린다(BM·브레인 스토밍과 같은 방식). 서비스 이름 하나 → 계정 이름 후보 6개(바라는 점으로 다시 추천, ↗ 로 Instagram 에서 보고 ✓ 비었음 / ✕ 있음 — 서버는 Instagram 을 긁지 않는다) → 게이트 ①가입 ②연결 ③프로필(설명 → 소개문 3안 고르기 → 붙여넣기) → 노선도
- 노선도: 위 Instagram, 아래 Threads. 역 = 게시물. 점선 초안 · 형광 승인 대기 · 빈 원 예약 · 채운 원 게시됨 · 붉은 원 실패
- 「이번 주 채우기」: 슬롯(기본 Instagram 화·금 20:00, Threads 평일 12:30)마다 각도를 돌려 초안 → 다듬기 → 카드(JPEG) → 승인 대기(또는 자동 예약)
- 5분 크론이 예약된 역을 올린다(이번 틱 컨테이너 → 다음 틱 상태 확인·게시, 실패 3회 뒤 실패 표시). 매일 09:00 KST 지표·요약·토큰 갱신

## 구조

```
public/            정적 화면 (Workers 정적 자산)
  index.html · app.css · favicon.svg · _headers
  js/main.js       화면 흐름(잠금 · 시작 · 후보 · 게이트 · 노선도 · 역 상세 · 소재 · 설정)
  js/linemap.js    주간 노선도 SVG
  js/api.js        서버 호출 · 열쇠 보관
  js/ui.js         요소·토스트·겹창·KST 시간 도우미
src/index.js       Worker — 길(route) · 크론 · 공개 미디어(/media)
lib/
  auth.js          암호 → 열쇠(HMAC) · OAuth state 서명
  crypto.js        Meta 토큰 봉인(AES-GCM)
  db.js            D1 표(첫 요청 때 만든다)
  plan.js          순수 로직 — KST·슬롯·각도 순환·상태 전이·검증
  ai.js            Claude 호출(JSON) · 연습 모드(MOCK_AI)
  prompts.js       AI 지시문
  meta.js          Instagram(Instagram 로그인) · Threads API
  render.js        카드 HTML → JPEG(Browser Rendering)
  media.js         공개 미디어 저장(Workers KV)
  ops.js           생성·계획·게시·지표·요약
tests/             node --test (순수 로직) · smoke.mjs (로컬 wrangler dev 상대 흐름 시험)
scripts/           stamp.mjs(판 번호) · check.mjs(문법) · autopush.mjs(자동 커밋·푸시)
wrangler.jsonc     바인딩(D1 · KV · Browser) · 크론 · 공개 변수 (비밀 아님)
```

## 운영자 설정 (사람이 한 번)

Cloudflare 대시보드 › **pensieve-instagram** › 설정 › **빌드 › 변수 및 암호** → 유형 **비밀** (배포 명령 `node scripts/deploy.mjs` 가 배포 때마다 런타임 비밀로 옮긴다. 설정 › 변수 및 비밀(런타임)에 직접 넣어도 된다):

- `PASSWORDS` — `이름=암호` 를 쉼표로 여러 개 (BM·브레인 스토밍과 같은 형식). 이름마다 공간이 따로
- `ANTHROPIC_API_KEY` — Claude 키
- `IG_APP_ID` · `IG_APP_SECRET` — Meta 앱 › Instagram › *API setup with Instagram login*
- `THREADS_APP_ID` · `THREADS_APP_SECRET` — Meta 앱 › Threads API
- `SESSION_SECRET` — Meta 토큰 봉인용 긴 임의 문자열(16자 이상). **없으면 계정 연결을 받지 않는다** — 암호(PASSWORDS)를 바꿔도 연결이 살아 있으려면 고정 비밀이 따로 있어야 한다

Meta 앱(developers.facebook.com)에서:
- 되돌아올 주소: `https://instagram.pensieve.kr/api/oauth/ig/callback`, `https://instagram.pensieve.kr/api/oauth/threads/callback`
- 앱 역할에 운영할 Instagram 계정 추가 — 자체 계정은 앱 심사 없이 개발 모드로 충분
- Instagram 계정은 **프로페셔널**(비즈니스/크리에이터) 이어야 연결된다

Cloudflare 자원(전부 무료 요금제, 카드 불필요): D1 `instagram` · KV `instagram-media`(이미지 공개 서빙) · Browser Rendering(카드 이미지; 없으면 소재 이미지만 쓴다) · 크론 `*/5 * * * *` 하나(00:00 UTC 틱이 하루 일도 함께)

## 로컬 실행 · 검사

```bash
npm install
npm run dev          # wrangler dev — MOCK_AI=1, 암호 test, SESSION_SECRET 개발용
npm test             # 순수 로직 단위 시험
node tests/smoke.mjs # dev 서버 상대 흐름 시험(로그인 → 서비스 → 소재 → 채우기 → 역 조작 → 크론 → 지우기)
npm run check        # 문법 검사
```

## 배포

`main` 푸시 → Cloudflare Workers Builds (빌드 `node scripts/stamp.mjs`, 배포 `node scripts/deploy.mjs` = wrangler deploy + 빌드 비밀 → 런타임 비밀) → instagram.pensieve.kr

## 지키는 것

- 비공식 자동화 없음 — 가입·프로필 수정은 사람이(게이트). API 한도 안에서만(Instagram 100/일, Threads 250/일)
- 실패는 조용히 넘기지 않는다 — 역에 오류가 적히고 기록에 남고 신호가 뜬다
- 비밀값은 커밋하지 않는다 — Cloudflare 변수에만
