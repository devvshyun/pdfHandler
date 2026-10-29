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
4. 영역에 걸친 **이미지(스캔 문서)는 해당 픽셀을 덮어쓴 사본**으로 바꿉니다(`image-redact.ts`). 이미지 배치(단위 정사각형 × CTM)를 역변환해 회전·기울어진 이미지도 픽셀 단위로 계산하고, 다른 곳에서 쓰는 같은 이미지는 원본을 유지합니다. Flate/LZW/무압축(1·2·4·8·16비트, Gray/RGB/CMYK/ICC/Indexed 등, 이미지 마스크·SMask 포함)은 코어가 직접 처리하고, JPEG는 주입한 `imageCodec`으로 처리합니다(브라우저: `frontend/src/image-codec.ts`).
5. `sanitize`(기본 켜짐): 지운 내용을 감싼 marked content와 구조 트리(태그 PDF) 요소의 `/ActualText`·`/Alt`·`/E`, 페이지 썸네일을 지웁니다. 겹친 입력란은 값과 함께 폼 필드 트리에서도 빠지고, 지운 주석의 팝업·답글도 함께 지웁니다.
6. 저장 전에 참조되지 않는 객체를 정리해, 교체된 원본 스트림·이미지가 파일에 남지 않게 합니다.

문서 속성·XMP·JavaScript·첨부파일·책갈피는 본문과 별개라 `redact`가 건드리지 않습니다. 별도 작업 `{ "type": "sanitize" }`(항목별 `removeMetadata`, `removeXmp`, `removeJavaScript`, `removeEmbeddedFiles`, `removeOutlines`, 기본 모두 true)로 지웁니다.

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
npm test          # core 59개(삭제·이미지·sanitize·텍스트 교체 43개 포함) + backend 3개
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

지원 작업: `rotate`, `delete`, `reorder`, `extract`, `duplicate`, `insertBlank`, `watermark`, `pageNumbers`, `addText`, `addImage`, `redact`, `replaceText`, `sanitize`, `metadata` — 타입 정의는 `packages/core/src/operations.ts` 참고.

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
* **영역 삭제의 범위**: 페이지 본문과 Form XObject의 글자, 이미지의 해당 픽셀, 겹치는 주석·입력란(값 포함), 관련 대체 텍스트(`/ActualText`·`/Alt`)는 파일에서 지워집니다. 텍스트 수정은 글자만 바꾸고 링크·입력란은 그대로 둡니다. 다음은 지워지지 않으니 확인이 필요합니다.
  * 처리할 수 없는 이미지 형식(JBIG2, JPEG 2000, CCITT): 검게 덮기만 하고 결과 메시지에 형식과 함께 알립니다. **서버 API(Node)에는 JPEG 코덱이 없어** JPEG 이미지도 덮기만 합니다(`imagesUnredacted`로 보고). 브라우저에서는 JPEG도 픽셀을 지웁니다.
  * 지운 픽셀은 채우기 색(기본 검정, `fill: null`이면 검정)으로 바뀝니다. 브라우저가 CMYK JPEG를 RGB로 디코딩하므로 그런 이미지는 RGB로 저장되고, 회색조 JPEG는 무손실(Flate)로 저장돼 파일이 커질 수 있습니다. 픽셀 경계는 바깥쪽으로 반올림됩니다.
  * 색상 키 마스크(`/Mask` 배열)는 그대로 두고, 처리할 수 없는 SMask는 제거합니다(그 이미지는 불투명하게 보임).
  * 글자를 도형(패스)으로 그린 PDF, 구조 트리의 `/T`(제목) 등 대체 텍스트 외 속성
  * 문서 속성·XMP·책갈피·첨부파일·스크립트: `sanitize` 작업으로 따로 지웁니다.
  * 서버 문서함의 **이전 버전**: 원본이 그대로 보관되므로 민감 정보라면 문서를 새로 올리고 원본 문서를 삭제하세요.
* 텍스트 수정은 **원본 글꼴에 필요한 글자가 모두 있으면 그 글꼴을 그대로** 씁니다(문서에 이미 쓰인 숫자·이름 수정 등). 없는 글자가 있으면 영문은 비슷한 표준 글꼴(Times/Helvetica, 굵기 반영), 한글은 이미지로 넣습니다.
* 한 줄 안에서 굵기·색이 섞인 구간을 고치면 한 가지 스타일로 합쳐집니다. 줄바꿈은 다시 하지 않으므로, 줄 공간을 넘치면 글자 폭을 최대 60%까지 줄이고 그래도 넘치면 경고합니다.
* 파일 저장소는 로컬 디스크입니다. `StorageService`만 교체하면 S3 등으로 옮길 수 있습니다.
* 인증/권한이 없습니다. 외부에 공개하려면 인증 계층을 먼저 추가하세요.
