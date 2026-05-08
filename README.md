# ClassBridge

실시간 익명 수업 소통 도구. 학생은 QR 스캔으로 접속해 자신의 상태(이해 완료 / 속도 조절 / 재설명)를 토글하거나 익명 질문을 보내고, 교수자는 데스크톱 위젯으로 실시간 확인합니다.

서비스: https://classbridge.fly.dev (베타)

---

## 교수님용

### 다운로드

[Releases 페이지](../../releases/latest)에서 본인 OS용 파일을 받으세요.

- macOS Apple Silicon: `ClassBridge-x.y.z-arm64.dmg`
- macOS Intel: `ClassBridge-x.y.z.dmg`
- Windows: `ClassBridge-Setup-x.y.z.exe`

학생 측은 별도 앱 없음 — 발급된 QR/링크를 모바일 브라우저로 열면 됩니다.

### 설치 (보안 경고 풀기)

베타 단계라 코드사이닝이 없어 OS가 한 번 명시 허용을 요구합니다.

**macOS**

1. `.dmg` 더블클릭 → ClassBridge를 응용 프로그램 폴더로 드래그.
2. ClassBridge 더블클릭 → "확인되지 않은 개발자" → **완료**.
3. **시스템 설정 → 개인정보 보호 및 보안** → 스크롤 후 **"그래도 열기"** → 암호/Touch ID → **열기**.
4. 이후엔 더블클릭으로 실행.

(macOS 14 이하는 응용 프로그램에서 우클릭 → 열기로 한 번에 통과됩니다.)

**Windows**

`.exe` 더블클릭 → "Windows의 PC 보호" → **추가 정보** → **실행** → 설치 마법사 진행.

### 사용

1. 앱 실행 → "+ 새 강의 만들기" → 이름(선택).
2. 학생 QR/링크 한 번 공유 (학기 내내 같은 링크).
3. 매 수업마다 ▶ **수업 시작** / 끝나면 **수업 종료** (또는 위젯 ✕).
4. 종료된 회차는 **지난 회차**에서 학생 수·상태 분포·질문 확인.

수업 중 위젯을 **미니 모드**로 줄여 PPT 위에 작은 신호등 한 줄로 띄울 수 있습니다.

### 안전성

- **앱이 하는 일**: `https://classbridge.fly.dev` 페이지를 띄우는 Electron 셸. 파일·카메라·마이크 등 OS 권한 요청 없음.
- **로컬 저장**: 강의 목록과 권한 토큰만 사용자 폴더에 JSON. 그 외 데이터 디스크 미저장.
- **통신**: HTTPS/WSS(TLS)만, Fly.io 도쿄 리전. Redis 1년 후 자동 삭제.
- **오픈소스**: 운영 코드 = 본 저장소. 빌드도 [공개 워크플로](.github/workflows/release.yml). 직접 빌드(`cd electron && npm run dist:mac`)도 가능.
- **수집 항목**: [개인정보처리방침](https://classbridge.fly.dev/privacy).

---

## 팀원용 — 개발 환경 셋업

### 요구사항
- Node.js 20+
- npm

### 클론 + 설치
```bash
git clone https://github.com/<owner>/classbridge.git
cd classbridge
npm install
cd electron && npm install && cd ..
```

### 로컬 개발

**서버 + 학생 화면 (브라우저용)**
```bash
npm run dev
# http://localhost:3000
```

**Electron 위젯 (교수자 — 별도 터미널)**
```bash
cd electron && npm run dev
# CLASSBRIDGE_URL=http://localhost:3000 으로 자동 가리킴
```

기본은 **인메모리 모드**(REDIS_URL 미설정). 단일 인스턴스 개발에 적합. 멀티 인스턴스 테스트 시:
```bash
REDIS_URL=redis://localhost:6379 npm run dev
```

### 디렉토리 구조
```
server.js                 Custom Next + Socket.IO 서버 (Redis 어댑터 옵션)
next.config.js            Next.js 설정 + 보안 헤더(CSP 등)
package.json              의존성, 스크립트
tsconfig.json             TypeScript 설정
tailwind.config.js        Tailwind 설정
postcss.config.js         PostCSS 설정
Dockerfile                컨테이너 이미지 정의
fly.toml                  Fly.io 배포 설정
nixpacks.toml             Nixpacks 빌드 설정 (대안)

src/
  pages/
    _document.tsx         공통 head (favicon, manifest, OG, security meta)
    _app.tsx              Next App
    index.tsx             학생용 코드 입력 / 교수자 강의 목록
    p/[roomId].tsx        교수자 위젯 (검토 / 라이브 모드)
    s/[roomId].tsx        학생 화면 (대기실 / 라이브)
    privacy.tsx           개인정보처리방침
  components/
    Charts.tsx            SVG 차트 (수업 흐름)
  lib/
    socket.ts             Socket.IO 클라이언트 싱글톤
    courseStore.ts        강의 목록 localStorage + Electron fs 백업

electron/
  main.js                 Electron 메인 (랜딩 창, 위젯 창)
  preload.js              renderer 노출 API
  package.json            Electron 빌드 설정 (electron-builder)
  build/icon.png          앱 아이콘 (1024×1024, 빌드 시 .icns/.ico 자동 생성)

public/                   favicon, manifest, og-image, icon-*.png
.github/workflows/        Release 자동화 (tag → dmg/exe 빌드 + 업로드)
```

### 핵심 이벤트 (Socket.IO)

**클라 → 서버**
| 이벤트 | 누가 | 설명 |
|---|---|---|
| `create-course` (legacy `create-room`) | 교수자 | 새 강의 생성. `{ roomId, courseId, ownerToken }` 응답 |
| `join-course` (legacy `join-room`) | 양쪽 | 입장. 학생은 `studentId` 필수, 교수자는 `ownerToken` 필수 |
| `session-start` | 교수자 | 라이브 회차 시작 (멱등) |
| `session-end` | 교수자 | 회차 종료 (위젯 ✕ / Cmd+Q에서도 자동 호출) |
| `reaction` | 학생 | 현재 상태 토글 (`green` / `yellow` / `red`) — 같은 색 다시 누르면 해제 |
| `question` | 학생 | 익명 질문 (50자 이내) |
| `dismiss-question` | 교수자 | 단일 질문 제거 |
| `course-rename` | 교수자 | 강의 이름 변경 |
| `delete-archived-session` | 교수자 | 종료된 회차 영구 삭제 |

**서버 → 클라 (broadcast/emit)**
- `room-state` — 위젯이 join 시 받음 (현재 상태 분포 + archivedSessions[])
- `session-waiting` — 학생이 비활성 강의에 join 시 (대기실)
- `room-joined` — 학생이 라이브 강의에 join 성공 (`myState`, 강의 이름 포함)
- `session-started` / `session-ended` — 회차 라이프사이클 broadcast
- `student-count` / `reaction-update` — 분포 변화 broadcast
- `my-state` — 학생 본인의 토글 상태 정정 (서버 진실)
- `new-question` / `question-dismissed` — 질문 변화
- `course-renamed` — 강의 이름 갱신
- `archived-deleted` — 회차 삭제 갱신
- `join-error` / `rate-limited` — 에러/제한

### 데이터 모델 (schema v3)

**Course** (영구 — 1년 보관)
- `ownerToken`: 32-hex 교수자 인증 토큰
- `name`: 강의 이름 (선택, 60자 이내)
- `currentSession`: 라이브 회차 1개 또는 null
- `archivedSessions[]`: 종료된 회차 (메타 + timeline + 질문 본문, 최대 30개)

**Session — 누적 카운터 X, 실시간 상태 모델**
- `students: { [studentId]: { state, sockets[], joinedAt, lastReactionAt } }`
  - 학생 디바이스별 현재 상태(`'green' | 'yellow' | 'red' | null`)
  - 같은 `studentId`로 여러 socket 연결 시 한 학생으로 dedupe
- `reactions`/`counts`(derived): `{ green, yellow, red, none }` — 각 상태 학생 수
- `questions[]`, `peakStudentCount`
- `timeline[]`: 상태 변화 시점에 push (`{ t, counts, studentCount }`, 50ms 이내 변화는 마지막 점에 덮어쓰기, 최대 1000포인트)
- `lastSeen`: 교수자 disconnect 후 grace 판정용 (1시간)

### 보안

- 교수자 인증: `ownerToken`(32-hex) — URL fragment(`#t=`)로 전달, sessionStorage + localStorage + Electron `userData/courses.json` 다중 보관
- 학생 디바이스 ID: `localStorage['cb-sid']`(uuid) — 동일 학생의 다중 접속/visibility 토글에서 +1 카운트 방지. 익명 식별자로 서버는 IP/이름 등과 연결 불가.
- Rate limit (socket당): `reaction` 50ms / `question` 5s / `create-course` 10s
- 명시적 종료 흐름: 위젯 ✕ / Cmd+Q → IPC `flush-session` → renderer `session-end` emit → main `destroy()` (안전망 600ms)
- 1시간 grace: 교수자 wifi 끊김에 회차가 쪼개지지 않도록

### 배포 (production — Fly.io)

```bash
# Redis 어댑터 + CORS 화이트리스트
fly secrets set REDIS_URL='redis://...' CORS_ORIGIN='https://classbridge.fly.dev'
fly deploy
```

### 데스크톱 빌드 (수동)

```bash
cd electron
npm run dist:mac      # macOS .dmg
npm run dist:win      # Windows .exe
# 산출물: dist-electron/
```

자동 빌드는 GitHub Actions (`.github/workflows/release.yml`)에서 tag push 시 트리거됨.

---

## 라이선스

베타 단계 — 외부 공개 라이선스 미정.
