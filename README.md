# 르네 콘솔 — instagram.pensieve.kr

르네(René) 게시물을 Claude 로 만들고, 고르고, Instagram·Threads(·X 2차)에 올리는 콘솔. 공식 API 만 쓴다.

- 기획안: [docs/기획안.html](docs/기획안.html) — 결론 · 노선도 · 흐름 · 화면 · 디자인 시스템 · 바뀌는 것 · 단계 · 정할 것
- 맨 처음 **암호**(BM·브레인 스토밍과 같은 형식). 어느 암호든 같은 르네 콘솔 — 승인한 사람 이름만 남는다
- **노선도**: 계정마다 한 줄(색), 게시물은 줄 위의 역. 점선 줄 = 아직 연결 전 · 호박색으로 숨 쉬는 역 = 내 차례(승인 대기) · 빈 원 = 예약 · 채운 원 = 올라감 · 붉은 원 = 실패 · 회색 띠 = 같은 글감(환승)
- **＋ 만들기**: 글감 한 줄 + 소재 + 줄 고르기 → Claude 가 브랜드 시트의 사실만으로 계정마다 글·카드(르네 디자인)를 만들고 「내 차례」로 세운다
- **역**: 휴대폰 미리보기 · 형식(사진·캐러셀·릴스·스토리 / 글·사진·영상·캐러셀) · 장 순서 · 글 · 해시태그 · 첫 댓글 · 시간 · 「한 마디로 고치기」 → 승인 / 지금 올리기 / 건너뛰기
- **보관함**: 폴더째 놓으면 묶음대로 게시물이 된다(`public/js/folder.js` 규칙: 미디어가 든 맨 아래 폴더 = 게시물 하나, 스토리는 사진마다, `캡션.txt`·`글.txt`·`첫댓글.txt`)
- **채널**: 줄마다 연결 — Instagram 은 「불러오기」(포트폴리오에 배정된 계정을 다시 로그인 없이), Threads 는 「로그인」, X 는 2차 · 기본 시간대 · 줄 더하기
- **대기 명단**(사람 아이콘): pensieve.kr/early 신청이 쌓인다 — 총 · 얼리버드 남은 수(선착순 N 바꾸기) · 출처(`?src=`)별 · 컬러별 · 날짜별 · CSV. 홈페이지는 `POST /api/waitlist`(pensieve.kr 출처만, 열쇠 없음)로 넣고 `GET /api/waitlist/stats` 로 「벌써 N명」을 읽는다
- 5분 크론이 예약을 올린다(컨테이너 → 처리 확인 → 게시 → 첫 댓글, 한 틱 외부 호출 40번 안쪽). 매일 09:00 KST 지표 · Threads 토큰 갱신

## 구조

```
public/            정적 화면 (Workers 정적 자산)
  index.html · app.css · favicon.svg · _headers
  js/main.js       화면 흐름(잠금 · 머리 · 노선도 · 시트: 만들기·역·보관함·채널·브랜드)
  js/map.js        노선도 SVG
  js/folder.js     폴더 → 게시물 묶음(순수 — 시험도 같이 쓴다)
  js/api.js · js/ui.js
src/index.js       Worker — 길(route) · 크론 · 공개 미디어(/media, Range)
lib/
  db.js            D1 표(r_*) · 옛 홍보실 연결 토큰 옮기기 · 점선 줄 세우기
  plan.js          순수 로직 — KST · 형식·검증 · 상태 전이 · 시간 제안 · 브랜드 시트
  publish.js       게시 한 걸음씩(캐러셀 자식 → 부모 → 게시 → 첫 댓글) — 가짜 API 로 시험
  prompts.js       Claude 지시문(만들기 · 고치기)
  ai.js            Claude 호출(JSON) · 연습 모드(MOCK_AI)
  render.js        르네 카드 틀 → JPEG(Browser Rendering)
  meta.js          Instagram(Unified login) · Threads API
  ops.js           줄·소재·게시물·만들기·게시·지표
  auth.js · crypto.js · http.js · media.js
tests/             node --test (plan·publish·folder·db·auth) · smoke.mjs (로컬 wrangler dev 상대 흐름 시험)
```

## 저장소

D1 `instagram` — `r_accounts`(줄·봉인 토큰) · `r_posts` · `r_ideas`(글감) · `r_assets`(소재) · `r_events` · `r_meta`(브랜드 시트·선착순 N 등) · `r_waitlist`(대기 명단 — 이메일·출처·컬러·구성·동의, IP 는 해시만). 첫 요청 때 만든다.
옛 홍보실 표(services·channels·posts…)가 있으면 **연결된 토큰만 옮기고** 옛 표는 지운다(한 번). 옛 KV 미디어(m/·c/)는 다음 09:00 크론이 지운다.
KV `instagram-media` — 소재·카드(`a/<id>.jpg|mp4`, 25MB 까지), `/media/<key>` 로 공개(Meta·Claude 가 가져간다).

## 운영자 설정 (사람이 한 번)

Cloudflare › **pensieve-instagram** › 설정 › 빌드 › 변수 및 암호(비밀) — `node scripts/deploy.mjs` 가 런타임 비밀로 옮긴다:
`PASSWORDS`(이름=암호, 쉼표) · `ANTHROPIC_API_KEY` · `IG_APP_SECRET` · `THREADS_APP_SECRET` · `SESSION_SECRET`(토큰 봉인, 16자+, 바꾸면 연결이 풀린다)

새 계정을 붙일 때:
- 영어 Instagram — 프로페셔널 계정 → 비즈니스 포트폴리오에 넣고 기존 시스템 사용자에 배정 → 채널 › IG EN › 불러오기
- 영어 Threads — Threads 앱 테스터 초대 수락 한 번 → 채널 › TH EN › 로그인 (앱 심사를 받으면 이 단계도 없어진다)
- X — 2차. X 개발자 계정 + 선불 크레딧(종량제) 필요
- Instagram 첫 댓글은 구성에 댓글 권한이 없으면 Meta 가 거절한다 → 게시는 되고 역에 경고만 남는다

## 로컬 실행 · 검사

```bash
npm install
npm run dev          # wrangler dev — MOCK_AI=1, 암호 test
npm test             # 순수 로직·게시 단계·폴더 규칙·저장소 이전
node tests/smoke.mjs # dev 서버 상대 흐름 시험
npm run check        # 문법 검사
```

## 배포

`main` 푸시 → Cloudflare Workers Builds (빌드 `node scripts/stamp.mjs`, 배포 `node scripts/deploy.mjs`) → instagram.pensieve.kr

## 지키는 것

- 비공식 자동화 없음 · 한도 안에서만(Instagram 100/일, Threads 250/일)
- 늘 사람이 승인 — 승인 사이 시간이 지나면 다시 고르게 한다(바로 올라가지 않게)
- 실패는 조용히 넘기지 않는다 — 역이 붉게 떨고 이유가 남는다
- 비밀값은 커밋하지 않는다
