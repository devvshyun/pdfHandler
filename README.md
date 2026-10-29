# pdfHandler

브라우저에서 PDF를 열람·편집하는 웹 애플리케이션입니다. [rhwp](https://edwardkim.github.io/rhwp/)가 HWP를 브라우저 안에서 처리하듯, PDF 렌더링과 편집을 클라이언트에서 수행하고 백엔드는 문서 보관·버전 관리·서버 측 일괄 작업을 담당합니다.

| 계층 | 기술 |
| --- | --- |
| 렌더링 | [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist` 4.10) – 캔버스 렌더링, 텍스트 레이어(선택/복사), 검색 |
| 편집 엔진 | [pdf-lib](https://github.com/Hopding/pdf-lib) – 브라우저와 서버가 **같은 코드**(`packages/core`)를 공유 |
| 프론트엔드 | TypeScript + Vite (프레임워크 없음) |
| 백엔드 | TypeScript, NestJS 11, MikroORM 6 |
| 저장소 | MySQL 8 (메타데이터·버전), 로컬 디스크 (PDF 파일), Redis (캐시·분산 락) |

## 기능

| 구분 | 기능 |
| --- | --- |
| 보기 | 연속 스크롤, 폭/쪽 맞춤·배율, 썸네일, 쪽 이동, 텍스트 선택·복사, 문서 내 검색 |
| 쪽 편집 | 회전, 삭제, 복제, 빈 쪽 삽입, 썸네일 드래그로 순서 변경(다중 선택 지원) |
| 문서 작업 | 병합, 분할(N쪽마다/범위), 쪽 추출, 워터마크, 쪽 번호, 문서 속성 |
| 텍스트 수정 | 기존 텍스트를 클릭해 그 줄 구간을 고치기. 원본 글자를 파일에서 지우고 같은 기준선·색·글꼴(원본 글꼴에 글자가 있을 때)로 다시 쓰며, 넘치면 글자 폭을 줄여 맞춤 |
| 영역 삭제 | 드래그한 영역의 글자를 파일에서 완전히 삭제(redaction)하고 검게 칠함 |
| 주석 | 텍스트, 펜, 형광펜, 사각형, 가리기(흰색), 이미지/서명 |
| 기타 | 실행 취소/다시 실행(30단계), 드래그&드롭 열기, 단축키, 다크 모드 |
| 서버 | 문서함, 버전 기록·복원, 서버 측 작업 API, 무상태 도구 API |

* **한글 지원**: 주석과 워터마크는 브라우저에서 PNG로 래스터화해 넣으므로 폰트를 내장하지 않아도 한글이 깨지지 않습니다. 서버 측 텍스트 작업(`watermark`, `addText`)에서 한글을 쓰려면 `PDF_FONT_PATH`에 TTF/OTF를 지정하세요.
* **오프라인 동작**: 백엔드가 없어도 편집 기능은 모두 동작합니다. 서버 저장·문서함만 비활성화됩니다.
* **회전된 쪽**: 모든 좌표는 "화면에 보이는 쪽" 기준으로 받아 `/Rotate`를 역변환하므로, 회전된 쪽에서도 클릭한 위치에 정확히 들어갑니다.

## 구조

```
packages/core   pdf-lib 기반 작업 엔진 (브라우저·서버 공용) + 단위 테스트
backend         NestJS API (documents, tools, health), MikroORM 엔티티/마이그레이션, Redis
frontend        Vite 앱: viewer(pdf.js) · annotate · raster · api · main
```

### 영역 삭제(redaction) 엔진 — `packages/core/src/redact.ts`

1. 페이지 콘텐츠 스트림을 해석해 글자마다 실제 위치(텍스트 행렬 × CTM, 글꼴 폭)를 계산합니다. 표준 14 글꼴, TrueType/Type1, Type3, Type0(CID, Identity-H 및 내장 CMap)을 지원합니다.
2. 영역에 걸친 글자를 `TJ` 문자열에서 빼고, 그 자리를 같은 폭의 이동값으로 바꿔 뒤 글자 위치가 그대로 유지됩니다. 바뀐 연산자만 다시 쓰고 나머지 바이트는 손대지 않습니다.
3. Form XObject 안의 글자도 지우며, 다른 페이지가 같은 XObject를 쓰면 그 페이지는 원본을 유지합니다.
4. 저장 전에 참조되지 않는 객체를 정리해, 교체된 원본 스트림이 파일에 남지 않게 합니다.

### 데이터 모델

| 테이블 | 주요 컬럼 |
| --- | --- |
| `users` | `id`(uuid), `email`(unique, 소문자), `password_hash`(scrypt, 사용자별 salt) |
| `documents` | `id`(uuid), `owner_id`(→ users, NULL 허용), `title`, `original_name`, `current_version`, `page_count`, `size` |
| `document_versions` | `document_id`, `version`(문서별 unique), `source`(upload / client_edit / server_operations), `storage_key`, `sha256`, `note`, `operations`(json) |

### Redis 사용처

| 키 | 용도 |
| --- | --- |
| `doc:<scope>:<id>` | 문서 상세 캐시 (TTL `CACHE_TTL_SECONDS`). `<scope>`는 `u:<userId>` 또는 `all`(단일 사용자 모드)이라 다른 사용자에게 캐시가 새지 않음 |
| `docs:list:<scope>:<gen>:…` + `gen:documents:<scope>` | 사용자별 목록 캐시. 변경 시 소유자·`all` 세대 번호를 올려 일괄 무효화 |
| `lock:doc:<id>` | 버전 번호 채번용 분산 락 (`SET NX PX` + Lua 해제). 여러 인스턴스가 동시에 저장해도 번호가 겹치지 않음 |
| `rl:<bucket>:<u:id 또는 ip:addr>` | 요청 수 제한 고정 윈도 카운터 (`INCR` + `EXPIRE`, Lua). 모든 인스턴스가 공유 |
| `rl:login-fail:<email 해시>` | 계정별 로그인 실패 횟수 (IP를 바꿔 가며 대입하는 공격 차단) |

`REDIS_KEY_PREFIX`를 주면 모든 키 앞에 붙습니다(같은 Redis를 여러 환경이 공유할 때).

Redis가 내려가도 캐시는 우회되고 락은 DB unique 제약이 최후 방어선이 되도록 설계했습니다.

## 실행

### Docker Compose (권장)

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
# http://localhost:3000  → 서버 문서함의 "회원가입"으로 계정을 만든 뒤 사용
```

컨테이너는 `NODE_ENV=production`이라 `JWT_SECRET`이 없으면 기동하지 않습니다.

### 로컬 개발

Node 22, MySQL 8, Redis 7이 필요합니다.

```bash
npm install
cp backend/.env.example backend/.env       # DB/Redis 접속 정보 수정
npm run build -w @pdfhandler/core          # 백엔드가 쓰는 core 빌드
npm run dev:backend                        # http://localhost:3000/api (기동 시 마이그레이션 자동 적용)
npm run dev:frontend                       # http://localhost:5173 (/api 는 3000으로 프록시)
```

프로덕션 빌드는 `npm run build` 한 번이면 되고, 백엔드가 `frontend/dist`를 정적 서빙합니다.
프론트엔드만 정적 호스팅(GitHub Pages 등)해도 편집기는 동작합니다. 다른 주소의 API를 쓰려면 `VITE_API_BASE`를 지정하세요.

### 테스트

```bash
npm test          # core 단위 테스트 + backend 단위 테스트 + backend API e2e
```

backend API e2e(`backend/test/e2e`)는 빌드된 서버(`dist/main.js`, 오래됐으면 자동 재빌드)를 실제 MySQL·Redis에 띄워 인증, 소유권 격리(캐시 포함), 버전 삭제, 업로드 제한, 요청 수 제한, 워커 풀을 검사합니다. 접속 정보는 `E2E_DB_HOST/PORT/USER/PASSWORD/NAME`(기본 DB `pdfhandler_test` — **테스트가 테이블을 지웁니다**), `E2E_REDIS_URL`. DB나 Redis에 닿지 않으면 이유를 출력하고 건너뜁니다(`E2E_REQUIRED=1`이면 실패). CI(`.github/workflows/ci.yml`)는 MySQL 8.4·Redis 7 서비스로 전부 실행합니다.

## REST API

모든 경로는 `/api` 접두사를 가집니다. 쪽 인덱스는 **0부터** 셉니다.

### 인증

* `POST /auth/register`, `POST /auth/login` — `{ "email", "password" }`(8자 이상) → `{ token, expiresAt, user }`. 토큰은 HS256 JWT(`JWT_SECRET`, 기본 12시간)입니다.
* `GET /auth/me` — 항상 200: `{ authRequired, user }` (토큰이 없거나 만료되면 `user: null`).
* `/documents/**`는 `Authorization: Bearer <token>`이 필요하고(없으면 401), **자기 문서만** 보입니다. 다른 사용자의 문서 id는 존재하지 않는 id와 똑같이 404를 돌려줘 id를 떠볼 수 없습니다.
* `AUTH_REQUIRED=false`: 로그인 없는 **단일 사용자 모드**(로컬 설치용). 모든 문서가 모두에게 보이고 새 문서는 소유자가 없습니다.
* 계정 도입 전에 올린 문서(`owner_id` NULL)는 `AUTH_REQUIRED=true`에서 **아무에게도 보이지 않습니다**. 넘기려면 `UPDATE documents SET owner_id = '<user id>' WHERE owner_id IS NULL;`.
* `/tools/**`는 로그인 없이 쓸 수 있고 IP별로 제한되며, `/health`는 공개입니다.

### 남용 방지

| 대상 | 기본 제한 | 변수 |
| --- | --- | --- |
| `/auth/register`, `/auth/login` | IP당 20회/60초 | `RATE_LIMIT_AUTH` |
| 로그인 실패 | 이메일당 10회/15분 (넘으면 맞는 비밀번호도 429) | `RATE_LIMIT_LOGIN` |
| `/tools/*` | IP당 30회/60초 | `RATE_LIMIT_TOOLS` |
| `/documents/*` | 사용자당 300회/60초 | `RATE_LIMIT_DOCUMENTS` |

초과하면 429와 `Retry-After`. 값은 `횟수/초`(예: `30/60`), `0`이면 끕니다. 리버스 프록시 뒤에서는 `TRUST_PROXY`를 설정해야 실제 클라이언트 IP로 셉니다.

업로드는 메모리가 아니라 `UPLOAD_TMP_DIR`에 디스크로 받고 요청이 끝나면(오류여도) 지웁니다. 파일 하나 `MAX_UPLOAD_MB`, 요청당 파일 `MAX_MERGE_FILES`개, 요청 전체 `MAX_REQUEST_MB`(Content-Length로 본문을 읽기 전에 먼저 거르고, 받은 뒤 합계도 확인)를 넘으면 413입니다.

PDF 처리(`getPdfInfo`/`applyOperations`/`mergePdfs`)는 `worker_threads` 풀(`PDF_WORKERS`개)에서 실행되어 요청 스레드를 막지 않습니다. 대기열(`PDF_QUEUE_MAX`)이 차면 즉시 503("서버가 … 바쁩니다"), `PDF_TASK_TIMEOUT_MS`를 넘긴 작업은 워커를 종료하고 503을 돌려줍니다. 작업 내용이 잘못되면(필드 타입, base64·PNG/JPEG가 아닌 이미지, 범위 밖 쪽 번호 등) `operations[i].field: …` 형태의 400입니다.

CORS 헤더는 기본적으로 보내지 않습니다(같은 출처만). 내장 프론트엔드는 같은 출처이고 `npm run dev:frontend`는 `/api`를 프록시하므로 개발 중에도 필요 없습니다. 다른 출처에서 API를 쓰려면 `CORS_ORIGINS=https://a.example,https://b.example`(모두 허용은 `*`).

### 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | DB·Redis·워커 풀 상태 |
| POST | `/auth/register` · `/auth/login` | 가입·로그인 → 토큰 |
| GET | `/auth/me` | 현재 사용자 |
| POST | `/documents` | 업로드 (multipart `file`, 선택 `title`) |
| GET | `/documents?page=&limit=&q=` | 목록 (제목 검색) |
| GET | `/documents/:id` | 상세 + 버전 목록 |
| PATCH | `/documents/:id` | 제목 변경 `{ "title": "..." }` |
| DELETE | `/documents/:id` | 문서와 모든 버전 삭제 |
| GET | `/documents/:id/file?version=&download=1` | PDF 내려받기 |
| POST | `/documents/:id/versions` | 브라우저에서 편집한 PDF를 새 버전으로 저장 (multipart `file`, `note`) |
| POST | `/documents/:id/operations` | 서버에서 작업 적용 후 새 버전 생성 |
| POST | `/documents/:id/versions/:v/revert` | 과거 버전을 새 최신 버전으로 복사 |
| DELETE | `/documents/:id/versions/:v` | 이전 버전 하나와 저장된 파일을 영구 삭제 (현재 버전은 400, 번호는 재사용하지 않음) → 문서 상세 |
| POST | `/documents/:id/versions/purge` | 현재 버전만 남기고 모두 삭제 → 문서 상세 + `deleted` |
| POST | `/tools/info` | PDF 정보 (저장 안 함) |
| POST | `/tools/merge` | multipart `files` 2개 이상 병합 → PDF |
| POST | `/tools/apply` | multipart `file` + `operations`(JSON 문자열) → PDF |

### 작업(operation) 예시

```bash
curl -X POST localhost:3000/api/documents/<id>/operations \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "note": "배포용 정리",
    "operations": [
      { "type": "delete", "pages": [0] },
      { "type": "rotate", "pages": [1, 2], "degrees": 90 },
      { "type": "watermark", "text": "CONFIDENTIAL", "opacity": 0.2 },
      { "type": "pageNumbers", "format": "{n} / {total}", "position": "bottom-center" }
    ]
  }'
```

지원 작업: `rotate`, `delete`, `reorder`, `extract`, `duplicate`, `insertBlank`, `watermark`, `pageNumbers`, `addText`, `addImage`, `redact`, `replaceText`, `metadata` — 타입 정의는 `packages/core/src/operations.ts` 참고.

## 환경 변수 (`backend/.env.example`)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | 3000 | |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 127.0.0.1 / 3306 / pdfhandler / pdfhandler / pdfhandler | MySQL |
| `DB_MIGRATE_ON_BOOT` | true | 기동 시 미적용 마이그레이션 실행 |
| `REDIS_URL` | redis://127.0.0.1:6379 | |
| `REDIS_KEY_PREFIX` | (없음) | 모든 Redis 키 접두사 |
| `CACHE_TTL_SECONDS` | 300 | |
| `STORAGE_DIR` | ./storage | PDF 저장 경로 |
| `MAX_UPLOAD_MB` | 100 | 파일 하나의 최대 크기 |
| `MAX_MERGE_FILES` | 20 | 요청 하나의 최대 파일 수 |
| `MAX_REQUEST_MB` | `MAX_UPLOAD_MB`×2 | 요청 전체(모든 파일 합계) 최대 크기 |
| `UPLOAD_TMP_DIR` | `<os tmp>/pdfhandler-uploads` | 업로드 임시 저장 경로 (요청 후 삭제) |
| `AUTH_REQUIRED` | true | false면 로그인 없는 단일 사용자 모드 |
| `JWT_SECRET` | (개발용 기본값 + 경고) | 토큰 서명 키. `NODE_ENV=production`에서는 **필수** (`openssl rand -hex 32`) |
| `JWT_TTL_SECONDS` | 43200 | 토큰 유효 시간 (12시간) |
| `CORS_ORIGINS` | (없음 = CORS 없음) | 허용 출처, 쉼표 구분. `*`는 전체 |
| `TRUST_PROXY` | false | Express `trust proxy` (예: `1`, `loopback`) |
| `RATE_LIMIT_AUTH` / `RATE_LIMIT_LOGIN` / `RATE_LIMIT_TOOLS` / `RATE_LIMIT_DOCUMENTS` | 20/60 · 10/900 · 30/60 · 300/60 | `횟수/초`, 0이면 끔 |
| `PDF_WORKERS` | CPU-1 (1~4) | PDF 워커 스레드 수. 0이면 요청 스레드에서 처리 |
| `PDF_QUEUE_MAX` | 16 | 대기 가능한 작업 수 (넘으면 503) |
| `PDF_TASK_TIMEOUT_MS` | 120000 | 작업 하나의 최대 시간 (넘으면 503) |
| `PDF_FONT_PATH` | (없음) | 서버 측 텍스트 작업용 TTF/OTF |
| `FRONTEND_DIST` | ../frontend/dist | 정적 서빙할 프론트엔드 빌드 경로 |

## 한계와 다음 단계

* 암호화된 PDF는 열람만 되고 편집은 거부됩니다(pdf-lib 제약).
* **영역 삭제/텍스트 수정의 범위**: 페이지 본문과 그 안의 Form XObject에 있는 글자, 겹치는 주석·입력란 값은 파일에서 지워집니다. 다음은 지워지지 않으니 확인이 필요합니다.
  * 스캔 이미지 속 글자(이미지는 검게 덮기만 함, 결과 메시지로 알림)
  * 글자를 도형(패스)으로 그린 PDF, 문서 속성·책갈피·첨부파일의 텍스트
  * 서버 문서함의 **이전 버전**: 원본이 그대로 보관되므로, 가린 뒤에는 버전 기록의 "이전 버전 모두 삭제"(또는 `POST /documents/:id/versions/purge`)로 옛 버전을 지우세요.
* 텍스트 수정은 **원본 글꼴에 필요한 글자가 모두 있으면 그 글꼴을 그대로** 씁니다(문서에 이미 쓰인 숫자·이름 수정 등). 없는 글자가 있으면 영문은 비슷한 표준 글꼴(Times/Helvetica, 굵기 반영), 한글은 이미지로 넣습니다.
* 한 줄 안에서 굵기·색이 섞인 구간을 고치면 한 가지 스타일로 합쳐집니다. 줄바꿈은 다시 하지 않으므로, 줄 공간을 넘치면 글자 폭을 최대 60%까지 줄이고 그래도 넘치면 경고합니다.
* 파일 저장소는 로컬 디스크입니다. `StorageService`만 교체하면 S3 등으로 옮길 수 있습니다.
* 인증은 이메일·비밀번호와 만료형 토큰뿐입니다(갱신 토큰·로그아웃 시 토큰 폐기·비밀번호 재설정·문서 공유 없음). 로그아웃은 브라우저에서 토큰을 지우는 것이며 토큰 자체는 만료까지 유효합니다.
* 요청 수 제한은 고정 윈도 방식이라 윈도 경계에서 순간적으로 최대 2배까지 통과할 수 있고, Redis가 내려가면 제한 없이 통과시킵니다(가용성 우선).
