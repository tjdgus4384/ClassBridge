# ClassBridge

실시간 익명 수업 소통 도구. 학생은 모바일로 QR 스캔만으로 접속해 수업 온도(이해 완료/속도 조절/재설명)와 익명 질문을 보내고, 교수자는 데스크톱 위젯으로 실시간 확인합니다.

**서비스**: https://classbridge.fly.dev (베타)

---

## 교수님용 — 설치 (다운로드)

데스크톱 위젯 앱은 [Releases](../../releases) 페이지에서 받으실 수 있습니다.

- **macOS**: `ClassBridge-x.y.z.dmg`
- **Windows**: `ClassBridge-Setup-x.y.z.exe`

### 처음 실행 시 보안 경고 (베타 단계)

본 앱은 베타 단계라 코드사이닝이 되어 있지 않아, 처음 실행 시 OS가 경고를 띄울 수 있습니다.

**macOS**
1. `.dmg` 파일을 열어 ClassBridge를 응용 프로그램 폴더로 끌어 놓기
2. 응용 프로그램에서 ClassBridge를 **우클릭 → 열기**
3. "확인되지 않은 개발자" 경고 → **열기** 한 번 더 클릭
4. 이후엔 일반 앱처럼 더블클릭으로 실행

**Windows**
1. `.exe`를 더블클릭 → "Windows의 PC 보호" 화면이 나오면
2. **추가 정보** 클릭 → **실행** 클릭
3. 설치 마법사 진행
4. 이후엔 시작 메뉴/바탕화면 아이콘으로 실행

### 사용 시작

1. 앱 실행 → "+ 새 강의 만들기" → 강의 이름 입력 (선택)
2. QR 코드 또는 학생 링크를 학생들에게 한 번 공유 (학기 내내 같은 링크 유지)
3. 매 수업 시작 시 위젯의 **▶ 수업 시작** 버튼
4. 수업 끝나면 **수업 종료** 버튼 (또는 위젯 ✕)
5. 종료된 회차는 "지난 회차"에서 학생 수 변화·리액션 흐름·질문 목록을 확인 가능

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
src/
  pages/
    index.tsx           학생용 코드 입력 / 교수자 강의 목록
    p/[roomId].tsx      교수자 위젯 (검토 / 라이브 모드)
    s/[roomId].tsx      학생 화면 (대기실 / 라이브)
    privacy.tsx         개인정보처리방침
  components/
    Charts.tsx          SVG 차트 (학생수·리액션 시계열)
  lib/
    socket.ts           Socket.IO 클라이언트 싱글톤
    courseStore.ts      강의 목록 localStorage + Electron fs 백업
electron/
  main.js               Electron 메인 (랜딩 창, 위젯 창)
  preload.js            renderer 노출 API
server.js               Custom Next + Socket.IO 서버 (Redis 어댑터 옵션)
public/                 favicon, manifest, og-image
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
- `timeline[]`: 15초 간격 lazy 스냅샷 (`{ t, counts, studentCount }`, 최대 1000포인트)
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
