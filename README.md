# 홍보실 (임시 이름) — instagram.pensieve.kr

펜시브 서비스의 Instagram·Threads 계정을 개설부터 게시·광고·감시까지 맡아 돌리는 운영 도구.

- 기획안(1차, 피드백용): [docs/기획안.html](docs/기획안.html) — 결론 · 흐름 · 운영 규칙 · 구조 · 단계 · 화면 · 디자인 시스템 · 결정 사항
- 배포: Cloudflare Workers(정적 화면 + API + Cron + Queues) → instagram.pensieve.kr
- 원칙: 공식 Meta API만 사용. 가입·연결·프로필 세 게이트만 사람이, 나머지는 시스템이.

기획 문서는 손으로 쓰는 HTML 하나가 원본이다. 고칠 일이 생기면 그 파일을 직접 고친다(날짜별 사본을 만들지 않는다).
