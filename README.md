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
| 텍스트 수정 | 기존 텍스트를 클릭해 고치기 (배경색으로 덮고 같은 위치·색으로 새 글자 배치) |
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

### 데이터 모델

| 테이블 | 주요 컬럼 |
| --- | --- |
| `documents` | `id`(uuid), `title`, `original_name`, `current_version`, `page_count`, `size` |
| `document_versions` | `document_id`, `version`(문서별 unique), `source`(upload / client_edit / server_operations), `storage_key`, `sha256`, `note`, `operations`(json) |

### Redis 사용처

| 키 | 용도 |
| --- | --- |
| `doc:<id>` | 문서 상세 캐시 (TTL `CACHE_TTL_SECONDS`) |
| `docs:list:<gen>:…` + `gen:documents` | 목록 캐시. 변경 시 세대 번호를 올려 일괄 무효화 |
| `lock:doc:<id>` | 버전 번호 채번용 분산 락 (`SET NX PX` + Lua 해제). 여러 인스턴스가 동시에 저장해도 번호가 겹치지 않음 |

Redis가 내려가도 캐시는 우회되고 락은 DB unique 제약이 최후 방어선이 되도록 설계했습니다.

## 실행

### Docker Compose (권장)

```bash
docker compose up --build
# http://localhost:3000
```

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
npm test          # core 16개 + backend 3개
```

## REST API

모든 경로는 `/api` 접두사를 가집니다. 쪽 인덱스는 **0부터** 셉니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | DB·Redis 상태 |
| POST | `/documents` | 업로드 (multipart `file`, 선택 `title`) |
| GET | `/documents?page=&limit=&q=` | 목록 (제목 검색) |
| GET | `/documents/:id` | 상세 + 버전 목록 |
| PATCH | `/documents/:id` | 제목 변경 `{ "title": "..." }` |
| DELETE | `/documents/:id` | 문서와 모든 버전 삭제 |
| GET | `/documents/:id/file?version=&download=1` | PDF 내려받기 |
| POST | `/documents/:id/versions` | 브라우저에서 편집한 PDF를 새 버전으로 저장 (multipart `file`, `note`) |
| POST | `/documents/:id/operations` | 서버에서 작업 적용 후 새 버전 생성 |
| POST | `/documents/:id/versions/:v/revert` | 과거 버전을 새 최신 버전으로 복사 |
| POST | `/tools/info` | PDF 정보 (저장 안 함) |
| POST | `/tools/merge` | multipart `files` 2개 이상 병합 → PDF |
| POST | `/tools/apply` | multipart `file` + `operations`(JSON 문자열) → PDF |

### 작업(operation) 예시

```bash
curl -X POST localhost:3000/api/documents/<id>/operations \
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

지원 작업: `rotate`, `delete`, `reorder`, `extract`, `duplicate`, `insertBlank`, `watermark`, `pageNumbers`, `addText`, `addImage`, `metadata` — 타입 정의는 `packages/core/src/operations.ts` 참고.

## 환경 변수 (`backend/.env.example`)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | 3000 | |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 127.0.0.1 / 3306 / pdfhandler / pdfhandler / pdfhandler | MySQL |
| `DB_MIGRATE_ON_BOOT` | true | 기동 시 미적용 마이그레이션 실행 |
| `REDIS_URL` | redis://127.0.0.1:6379 | |
| `CACHE_TTL_SECONDS` | 300 | |
| `STORAGE_DIR` | ./storage | PDF 저장 경로 |
| `MAX_UPLOAD_MB` | 100 | 업로드 최대 크기 |
| `PDF_FONT_PATH` | (없음) | 서버 측 텍스트 작업용 TTF/OTF |
| `FRONTEND_DIST` | ../frontend/dist | 정적 서빙할 프론트엔드 빌드 경로 |

## 한계와 다음 단계

* 암호화된 PDF는 열람만 되고 편집은 거부됩니다(pdf-lib 제약).
* 텍스트 수정은 원본 글자를 배경색 상자로 덮고 새 글자를 올리는 방식입니다. **원본 글자는 파일 안에 그대로 남아** 검색·복사로 보일 수 있으므로 개인정보 삭제(redaction) 용도로 쓰면 안 됩니다. 영문은 Helvetica 실제 텍스트로, 한글은 이미지로 들어가며 원래 글꼴은 유지되지 않습니다.
* 파일 저장소는 로컬 디스크입니다. `StorageService`만 교체하면 S3 등으로 옮길 수 있습니다.
* 인증/권한이 없습니다. 외부에 공개하려면 인증 계층을 먼저 추가하세요.
