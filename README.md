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

| 이벤트 | 방향 | 설명 |
|---|---|---|
| `create-room` | C→S | 새 강의 생성. `{ roomId, ownerToken }` 응답 |
| `join-room` | C→S | 입장 (`role: 'student' \| 'professor'`) |
| `session-start` | C→S | 교수자가 명시적으로 라이브 회차 시작 |
| `session-end` | C→S | 교수자가 명시적으로 회차 종료 |
| `reaction` | C→S | 학생 신호등 리액션 |
| `question` | C→S | 익명 질문 (50자 이내) |
| `dismiss-question` / `clear-reactions` | C→S | 교수자 액션 |
| `course-rename` | C→S | 강의 이름 변경 |
| `room-state` / `student-count` / `reaction-update` / `new-question` / `session-started` / `session-ended` / `course-renamed` / `join-error` / `rate-limited` | S→C | broadcast |

### 데이터 모델

**Course** (영구 — 1년 보관)
- `ownerToken`: 32-hex 교수자 인증 토큰
- `name`: 강의 이름 (선택)
- `currentSession`: 라이브 회차 1개 또는 null
- `archivedSessions[]`: 종료된 회차 메타 + 본문 (최대 30개)

**Session**
- `reactions: { green, yellow, red }`, `questions[]`, `studentCount`, `peakStudentCount`
- `timeline[]`: 1분 간격 스냅샷 (최대 240포인트)
- `lastSeen`: 교수자 disconnect 후 grace 판정용 (1시간)

### 보안

- 교수자 인증: `ownerToken`(32-hex) — URL fragment(`#t=`)로 전달, sessionStorage + localStorage + Electron `userData/courses.json` 다중 보관
- Rate limit: socket당 reaction 800ms / question 5s / create-room 10s
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
