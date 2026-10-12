# verify — 사이트 전체 SEO·GEO 진단 (로컬)

시작 주소를 넣으면 그 아래 모든 페이지를 찾아 페이지마다 SEO·GEO 점수를 매기고, 미흡한 항목과 수정 방법을 보여 준다.

- 페이지마다 수집 1회(Chromium 렌더링 포함) → `analyzeSeo` + `analyzeGeo` 순서로 처리한다.
- Schema.org 데이터 라이선스는 `THIRD_PARTY_NOTICES.md`.

## 실행

Node 22.17 이상. 최초 1회 이 폴더에서 `npm install`(Chromium이 없으면 `npm run browser:install`)과 `npm link`를 실행한다. `npm link`가 `verify`를 전역 명령으로 등록하므로 그 뒤로는 **어느 폴더에서든** 쓴다. 해제는 `npm unlink -g verify`.

```bash
verify                          # 도메인을 물어본다 → 입력하면 진단 시작
verify example.com              # 바로 진단
verify localhost:3000 --max 30  # 로컬 개발 서버
verify.cmd example.com          # cmd 에서는 내장 명령 VERIFY와 겹쳐 .cmd 를 붙인다
```

- 도메인을 넣으면 그 도메인 첫 페이지(`/`)부터 사이트 전체를 진단한다. 주소에 경로가 붙어 있어도 도메인만 쓴다.
- 진행 상황은 터미널 한 줄로 계속 갱신되고, 끝나면 **페이지별 점수 표**(SEO·GEO 점수와 등급, 개선 필요·권장 수, 주소)와 자주 나온 미흡 항목 표가 나온다. 결과는 파일로 저장하지 않는다.
- 페이지 렌더링에 쓰는 Chromium은 화면 없이(headless) 돈다. 창은 뜨지 않는다.
- Ctrl+C 한 번이면 진행 중인 페이지까지 마치고 결과를 출력한다. 두 번이면 바로 끝낸다.

옵션: `--max <n>`(기본 100, 최대 1000) · `--concurrency <1~20>`(기본 10) · `--no-sitemap` · `--help`

## 로컬 개발 서버 진단

`localhost:3000`, `http://127.0.0.1:5173`, `192.168.x.x` 같은 주소도 그대로 넣으면 된다. 프로토콜을 안 적으면 http로 접속한다.

- 수집기는 기본적으로 내부망 주소와 80·443 외 포트를 막는다. 시작 주소가 로컬일 때만 그 진단 동안 이 차단을 푼다. 공개 사이트를 진단할 때는 그대로 막는다.
- 채점 규칙은 같다. 다만 HTTPS·SSL 인증서, HTTP 링크·리소스 선언, HTTP 압축, 캐시 헤더처럼 배포 환경이 정하는 항목은 운영 사이트와 다르게 나온다.
- 개발 모드(`next dev` 등)는 운영 빌드와 HTML·속도가 다르다. 운영과 가깝게 보려면 `next build && next start`처럼 운영 빌드를 띄워 진단한다.

## 진단 범위

- 시작 주소와 같은 출처(프로토콜+호스트)인 페이지만 진단한다. 다른 도메인·서브도메인은 보지 않는다.
- 시작 주소가 리다이렉트되면(http→https, www 등) 최종 주소의 출처로 범위를 다시 잡는다.
- 페이지 찾기: ① 사이트맵(`/sitemap.xml`, robots.txt의 `Sitemap:`, sitemapindex 하위) ② 진단한 페이지의 렌더링 후 링크. 발견 순서대로 최대 페이지 수까지 진단한다.
- 제외: 쿼리스트링이 붙은 주소, logout·cart 같은 주소, 파일 확장자(pdf·이미지 등).
- 같은 페이지로 리다이렉트되는 주소는 "건너뜀"으로 표시한다. HTTP 오류·HTML이 아닌 주소는 "실패"로 이유와 함께 표시한다.

## 폴더 구성

| 경로 | 내용 |
|---|---|
| `bin/verify.js` | 전역 명령 `verify`의 진입점. `npm link`가 이 파일을 등록한다. 지우면 명령이 안 된다 |
| `src/cli.ts` | 입력 받기, 진행 줄, 결과 표 출력 |
| `src/crawl.ts` | 페이지 찾기(사이트맵·링크), 범위 판정, 동시 진단 |
| `src/collector/` | 페이지 수집 (HTTP 요청, Chromium 렌더링, 로컬 주소 허용 정책) |
| `src/core/` | SEO·GEO 채점 규칙. `schema-*.json`은 JSON-LD 검사에 쓰는 Schema.org 데이터 |
| `THIRD_PARTY_NOTICES.md` | Schema.org 데이터·jsonld 라이선스 고지 |

타입 검사: `npm run typecheck` (빌드 산출물은 만들지 않는다. 실행은 `tsx`가 `.ts`를 바로 돌린다)
