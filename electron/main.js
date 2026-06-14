const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// 배포된 서버 URL — 환경변수로 오버라이드 가능
// 개발 시: CLASSBRIDGE_URL=http://localhost:3000 npx electron .
const SERVER_URL = process.env.CLASSBRIDGE_URL || 'https://classbridge.fly.dev'

let mainWindow = null
let widgetWindow = null

// ── 명시적 종료 흐름 (flush before close) ────────────────────────────────
// 위젯창 닫기/Cmd+Q 시 렌더러에 'flush-session' 전송 → 렌더러는 socket.emit('session-end')
// 후 'flush-session-done' IPC 회신 → 그 시점에 위젯창 destroy.
let pendingFlushTimer = null
let isAppQuitting = false
let widgetClosing = false   // 닫는 중에는 사이즈 변경 IPC 무시 (검토 사이즈 깜빡임 방지)
let isLiveSession = false   // 렌더러가 set-live-state IPC 로 갱신. true 이면 ✕/Cmd+Q 시 confirm 요청.

// 라이브 중에만 실수 종료 confirm — 검토 모드면 그냥 닫음.
function confirmEndLiveSession(parent) {
  if (!isLiveSession) return true
  const win = parent && !parent.isDestroyed() ? parent : undefined
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    message: '진행 중인 수업이 있습니다',
    detail: '지금 닫으면 현재 회차가 종료됩니다.\n종료된 회차는 "지난 회차" 에서 다시 확인할 수 있습니다.',
    buttons: ['취소', '수업 종료하고 닫기'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return choice === 1
}

function flushSession(kind, onDone) {
  if (!widgetWindow || widgetWindow.isDestroyed()) { onDone(); return }
  if (pendingFlushTimer) { onDone(); return } // 이미 진행 중

  let done = false
  const finish = () => {
    if (done) return
    done = true
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null }
    ipcMain.removeListener('flush-session-done', finish)
    onDone()
  }
  ipcMain.once('flush-session-done', finish)
  // 안전망 — 렌더러가 죽었거나 응답이 없으면 600ms 후 진행
  pendingFlushTimer = setTimeout(finish, 600)
  try {
    widgetWindow.webContents.send('flush-session', { kind })
  } catch {
    finish()
  }
}

// ── 랜딩 창 (세션 생성용) ──────────────────────────────────────────────────
// 첫 실행 시 macOS 보안 검사 + Fly 페이지 fetch 가 합쳐서 5-10초 걸려서
// 사용자에겐 빈 화면이 한참 뜨는 것처럼 보임. 즉시 data: URL splash 띄우고 그 뒤에 실제 페이지 로드.
const SPLASH_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ClassBridge</title>
<style>
  html,body{margin:0;padding:0;background:#0a0a0a;color:#fff;height:100vh;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-user-select:none;}
  body{display:flex;align-items:center;justify-content:center;}
  .c{text-align:center;}
  .name{font-size:30px;font-weight:700;letter-spacing:-0.02em;}
  .sub{font-size:13px;color:rgba(255,255,255,0.45);margin-top:12px;}
  .d{display:inline-block;width:5px;height:5px;background:rgba(255,255,255,0.5);
    border-radius:50%;margin:0 2px;animation:b 1.2s infinite ease-in-out;}
  .d:nth-child(2){animation-delay:0.2s;}.d:nth-child(3){animation-delay:0.4s;}
  @keyframes b{0%,80%,100%{opacity:0.15;transform:translateY(0);}40%{opacity:1;transform:translateY(-2px);}}
</style></head><body>
<div class="c">
  <div class="name">ClassBridge</div>
  <div class="sub">시작하는 중<span class="d"></span><span class="d"></span><span class="d"></span></div>
</div></body></html>`

function createLandingWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 640,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false,                // splash 가 paint 되는 순간 ready-to-show 발화 → 그때 보임
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  // 1단계: 즉시 보이는 splash — data: URL 이라 네트워크 0, 렌더 ~ms 단위.
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 2단계: splash 가 화면에 박힌 직후 (~100ms) 실제 페이지로 전환.
  // 사용자 시점: 클릭 → splash 즉시 → 잠시 후 실제 콘텐츠.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(SERVER_URL)
    }
  }, 100)

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── 교수자 위젯 창 (Always on Top) ────────────────────────────────────────
// ownerToken 은 URL fragment(#t=...)에 실어 보낸다 — referrer/액세스 로그 노출 방지.
function createWidgetWindow(roomId, ownerToken) {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize

  widgetWindow = new BrowserWindow({
    width: 460,
    height: 720,
    x: sw - 480,
    y: 20,
    frame: false,
    transparent: true,                  // 미니 모드 비침용 (풀/검토는 CSS 거의 불투명)
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    show: false,                // 콘텐츠 준비될 때까지 숨김
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,           // Chromium sandbox 안에서 renderer 실행
      backgroundThrottling: false,   // ★ 가장 중요. PPT 풀스크린 뒤에서도 socket heartbeat 안 끊기게.
    },
  })

  widgetWindow.setAlwaysOnTop(true, 'screen-saver')

  const hash = ownerToken ? `#t=${encodeURIComponent(ownerToken)}` : ''
  widgetWindow.loadURL(`${SERVER_URL}/p/${roomId}?widget=1${hash}`)
  widgetWindow.once('ready-to-show', () => widgetWindow && widgetWindow.show())

  // 닫히기 직전 — 라이브 중이면 confirm 후 세션 종료 신호 emit 후 destroy
  widgetWindow.on('close', (e) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    if (widgetWindow._flushed) return // 이미 flush 후 destroy 진행 중
    // 라이브면 한 번 확인. 취소면 close 중단.
    if (!confirmEndLiveSession(widgetWindow)) {
      e.preventDefault()
      return
    }
    widgetClosing = true   // 사이즈 변경 차단
    e.preventDefault()
    flushSession('close', () => {
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow._flushed = true
        widgetWindow.destroy()
      }
    })
  })

  widgetWindow.on('closed', () => {
    widgetWindow = null
    widgetClosing = false
    isLiveSession = false  // 다음 위젯 진입 시 stale 상태로 confirm 뜨지 않도록
    popupModeActive = false
    savedWidgetBounds = null
    // 떠있던 풍선창 정리
    if (questionPopupWindow && !questionPopupWindow.isDestroyed()) {
      questionPopupWindow.close()
    }
    questionPopupWindow = null
    // 위젯 닫혔으면 랜딩으로 복귀 (앱 종료 중이면 skip)
    if (isAppQuitting) return
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    else createLandingWindow()
  })

  if (mainWindow) mainWindow.hide()
}

// ── IPC: 렌더러 → 메인 ────────────────────────────────────────────────────
ipcMain.on('open-widget', (_, { roomId, ownerToken }) => {
  if (widgetWindow) { widgetWindow.focus(); return }
  createWidgetWindow(roomId, ownerToken)
})

// 위젯 ✕ 버튼 — 위 'close' 핸들러가 flush 처리해준다
ipcMain.on('close-widget', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close()
})

// 미니/풀 모드 고정 크기
const MINI_W = 288
const MINI_H = 52
const FULL_W = 460
const FULL_H = 720

// 미니 토글은 라이브 모드 안에서만 발생 (미니 버튼이 라이브에서만 노출).
// → width는 현재 값 유지(라이브는 288). height만 토글.
// 미니→풀 시 임시 height로 키워두고, 곧 set-live-size의 ResizeObserver가 정확한 값으로 조정.
const LIVE_TEMP_HEIGHT = 400
ipcMain.on('toggle-compact', (_, { compact }) => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (widgetClosing) return  // 닫는 중에는 사이즈 변경 X

  const cur = widgetWindow.getBounds()
  const oldRight = cur.x + cur.width
  const newWidth = cur.width  // width 유지 (검토 사이즈로 깜빡이지 않게)
  const newHeight = compact ? MINI_H : LIVE_TEMP_HEIGHT

  // 우측 끝 + 상단 y 고정
  let newX = oldRight - newWidth
  let newY = cur.y
  const display = screen.getDisplayMatching(cur).workArea
  newX = Math.max(display.x, Math.min(newX, display.x + display.width - newWidth))
  newY = Math.max(display.y, Math.min(newY, display.y + display.height - newHeight))

  if (compact) {
    widgetWindow.setResizable(true)
    widgetWindow.setMinimumSize(newWidth, MINI_H)
    widgetWindow.setMaximumSize(newWidth, MINI_H)
    widgetWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight })
    widgetWindow.setResizable(false)
  } else {
    widgetWindow.setResizable(true)
    widgetWindow.setMinimumSize(0, 0)
    widgetWindow.setMaximumSize(0, 0)
    widgetWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight })
  }
})

// 렌더러 → main: 라이브 모드 진입/종료 시 호출. ✕/Cmd+Q confirm dialog 판단에 사용.
ipcMain.on('set-live-state', (_, live) => {
  isLiveSession = !!live
})

// http/https만 허용 — 위젯이 어떤 식으로든 compromise 되어도 임의 OS protocol handler 실행 차단.
ipcMain.on('open-external', (_, url) => {
  if (typeof url !== 'string') return
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    shell.openExternal(url)
  } catch {}
})

// 라이브/검토 모드별 위젯 사이즈 조절
//  - { mode: 'review' } → 검토 풀 사이즈 (FULL_W × FULL_H)
//  - { mode: 'live', contentHeight } → 미니 폭(288) × 본문 콘텐츠 높이
//  - 미니 모드(MINI_H)일 때는 무시 — 미니 토글이 따로 처리
const MIN_LIVE_HEIGHT = 120
ipcMain.on('set-live-size', (_, payload) => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (widgetClosing) return  // 닫는 중에는 사이즈 변경 X
  const cur = widgetWindow.getBounds()
  // 미니 모드면 무시 (height로 판정)
  if (cur.height <= MINI_H + 2) return

  const oldRight = cur.x + cur.width

  let newWidth, newHeight
  if (payload?.mode === 'review') {
    newWidth = FULL_W
    newHeight = FULL_H
  } else if (payload?.mode === 'live') {
    newWidth = MINI_W
    const h = Math.round(payload.contentHeight || 0)
    newHeight = Math.max(MIN_LIVE_HEIGHT, Math.min(h, FULL_H))
  } else {
    return
  }
  if (newWidth === cur.width && newHeight === cur.height) return

  // 우측 끝 + 상단 y 고정
  let newX = oldRight - newWidth
  let newY = cur.y
  const display = screen.getDisplayMatching(cur).workArea
  newX = Math.max(display.x, Math.min(newX, display.x + display.width - newWidth))
  newY = Math.max(display.y, Math.min(newY, display.y + display.height - newHeight))

  // resizable 잠금/풀기 패턴 (Windows 안전)
  widgetWindow.setResizable(true)
  widgetWindow.setMinimumSize(0, 0)
  widgetWindow.setMaximumSize(0, 0)
  widgetWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight })
})

// ── popup_only 모드 ─────────────────────────────────────────────────────────
// 위젯창 자체를 40×40 의 작은 "복귀 버튼" 창으로 축소.
// 질문 도착 시 위젯 옆에 단일 persistent BrowserWindow 풍선창이 떠 있음.
// 풍선창은 두 상태: BUBBLE (44×44, 카운트 배지) ↔ EXPANDED (~320×140, 본문).
// 클릭으로 토글. queue 빌 때까지 살아 있고, 빈 다음 자동으로 닫힘.
const POPUP_RETURN_W = 40
const POPUP_RETURN_H = 40
const QUESTION_POPUP_BUBBLE_W = 56
const QUESTION_POPUP_BUBBLE_H = 56
const QUESTION_POPUP_GAP = 6
const QUESTION_POPUP_MARGIN = 20
let popupModeActive = false
let savedWidgetBounds = null   // popup 진입 직전 위젯 사이즈 — 복귀 시 우선 사용
let questionPopupWindow = null // popup mode 의 단일 풍선창

function clampToDisplay(x, y, w, h, refBounds) {
  const display = screen.getDisplayMatching(refBounds || { x, y, width: w, height: h }).workArea
  const nx = Math.max(display.x, Math.min(x, display.x + display.width - w))
  const ny = Math.max(display.y, Math.min(y, display.y + display.height - h))
  return { x: nx, y: ny, width: w, height: h }
}

// 풍선창 위치 계산 — 위젯 왼쪽에 부착, 우측 끝 정렬.
// 위젯이 안 보이면 화면 우상단 fallback.
function popupPositionFor(w, h) {
  const widgetBounds = (widgetWindow && !widgetWindow.isDestroyed())
    ? widgetWindow.getBounds()
    : null
  let x, y
  if (widgetBounds) {
    x = widgetBounds.x - w - QUESTION_POPUP_GAP
    y = widgetBounds.y
  } else {
    const d = screen.getPrimaryDisplay().workArea
    x = d.x + d.width - w - QUESTION_POPUP_MARGIN
    y = d.y + QUESTION_POPUP_MARGIN
  }
  const refBounds = widgetBounds || { x, y, width: w, height: h }
  return clampToDisplay(x, y, w, h, refBounds)
}

ipcMain.on('enter-popup-mode', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (widgetClosing) return
  if (popupModeActive) return
  popupModeActive = true
  savedWidgetBounds = widgetWindow.getBounds()
  const cur = savedWidgetBounds
  const oldRight = cur.x + cur.width
  const bounds = clampToDisplay(oldRight - POPUP_RETURN_W, cur.y, POPUP_RETURN_W, POPUP_RETURN_H, cur)
  widgetWindow.setResizable(true)
  widgetWindow.setMinimumSize(POPUP_RETURN_W, POPUP_RETURN_H)
  widgetWindow.setMaximumSize(POPUP_RETURN_W, POPUP_RETURN_H)
  widgetWindow.setBounds(bounds)
  widgetWindow.setResizable(false)
})

ipcMain.on('exit-popup-mode', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  popupModeActive = false
  // 풍선창 정리
  if (questionPopupWindow && !questionPopupWindow.isDestroyed()) {
    questionPopupWindow.close()
  }
  questionPopupWindow = null
  // 위젯 사이즈 복원
  const cur = widgetWindow.getBounds()
  const oldRight = cur.x + cur.width
  const targetW = savedWidgetBounds?.width || MINI_W
  const targetH = savedWidgetBounds?.height || LIVE_TEMP_HEIGHT
  const bounds = clampToDisplay(oldRight - targetW, cur.y, targetW, targetH, cur)
  widgetWindow.setResizable(true)
  widgetWindow.setMinimumSize(0, 0)
  widgetWindow.setMaximumSize(0, 0)
  widgetWindow.setBounds(bounds)
  savedWidgetBounds = null
})

// 풍선창 HTML — bubble / expanded 상태 토글 inline JS.
// queue: 도착 순서대로 표시할 질문 목록. 사용자가 "확인" 으로 dismiss.
function makeQuestionPopupHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
<style>
  *,*::before,*::after{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:transparent;height:100vh;width:100vw;
    overflow:hidden;-webkit-user-select:none;user-select:none;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  #root{position:fixed;inset:0;}

  /* ─── bubble ─── */
  .bubble{position:absolute;inset:6px;border-radius:50%;
    background:rgba(10,10,10,0.92);
    display:flex;align-items:center;justify-content:center;cursor:pointer;
    box-shadow:0 6px 16px rgba(0,0,0,0.35),0 2px 4px rgba(0,0,0,0.2);
    transition:transform 0.15s ease,background 0.15s ease;
    animation:bubble-in 0.32s cubic-bezier(0.2,0.9,0.3,1) both;}
  .bubble:hover{background:rgba(20,20,20,0.96);transform:scale(1.06);}
  .bubble .ic{font-size:20px;line-height:1;}
  .badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;
    background:#ef4444;color:#fff;border-radius:9px;
    font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 4px rgba(0,0,0,0.25);border:1.5px solid rgba(10,10,10,0.92);}

  /* ─── expanded ─── */
  .expanded{position:absolute;inset:6px;background:#fff;border-radius:14px;
    box-shadow:0 12px 32px rgba(0,0,0,0.28),0 2px 6px rgba(0,0,0,0.14);
    padding:13px 14px 12px;display:flex;flex-direction:column;gap:8px;
    animation:expand-in 0.22s cubic-bezier(0.2,0.9,0.3,1) both;}
  .expanded .head{display:flex;align-items:center;justify-content:space-between;
    color:rgba(0,0,0,0.45);font-size:11px;font-weight:600;letter-spacing:0.02em;}
  .expanded .head .cnt{display:flex;align-items:center;gap:6px;}
  .expanded .head .dot{width:6px;height:6px;border-radius:50%;background:#10b981;}
  .expanded .head .coll{border:0;background:transparent;color:rgba(0,0,0,0.45);
    cursor:pointer;font-size:13px;padding:2px 6px;border-radius:6px;line-height:1;}
  .expanded .head .coll:hover{background:rgba(0,0,0,0.06);color:rgba(0,0,0,0.8);}
  .expanded .text{flex:1;color:#171717;font-size:14px;line-height:1.45;font-weight:500;
    word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;
    -webkit-box-orient:vertical;overflow:hidden;}
  .expanded .act{display:flex;justify-content:flex-end;}
  .expanded .ack{border:0;background:#0a0a0a;color:#fff;padding:7px 14px;
    border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;
    transition:background 0.15s ease;letter-spacing:0.01em;}
  .expanded .ack:hover{background:#262626;}

  @keyframes bubble-in{
    from{opacity:0;transform:scale(0.65);}
    to{opacity:1;transform:scale(1);}
  }
  @keyframes expand-in{
    from{opacity:0;transform:scale(0.94);}
    to{opacity:1;transform:scale(1);}
  }
</style></head>
<body>
<div id="root"></div>
<script>
  var queue = []; // { qid, text }
  var expanded = false;
  var BUBBLE_W = ${QUESTION_POPUP_BUBBLE_W}, BUBBLE_H = ${QUESTION_POPUP_BUBBLE_H};
  var EXPANDED_W = 320, EXPANDED_H = 140;
  var MAX_QUEUE = 30;
  var root = document.getElementById('root');

  function escHtml(s){return String(s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });}

  function render(){
    if(queue.length === 0){
      root.innerHTML = '';
      if(window.popupAPI) window.popupAPI.close();
      return;
    }
    if(expanded){
      var q = queue[0];
      var total = queue.length;
      var label = total > 1 ? ('질문 1 / ' + total) : '질문';
      var btnLabel = total > 1 ? '다음' : '확인';
      root.innerHTML =
        '<div class="expanded">' +
          '<div class="head">' +
            '<span class="cnt"><span class="dot"></span><span>' + label + '</span></span>' +
            '<button class="coll" id="coll" title="접기">▾</button>' +
          '</div>' +
          '<div class="text">' + escHtml(q.text) + '</div>' +
          '<div class="act"><button class="ack" id="ack">' + btnLabel + '</button></div>' +
        '</div>';
      document.getElementById('coll').addEventListener('click', collapse);
      document.getElementById('ack').addEventListener('click', advance);
    } else {
      var count = queue.length;
      var badgeHtml = count > 1 ? ('<span class="badge">' + (count > 99 ? '99+' : count) + '</span>') : '';
      root.innerHTML =
        '<div class="bubble" id="b"><span class="ic">💬</span>' + badgeHtml + '</div>';
      document.getElementById('b').addEventListener('click', expand);
    }
  }

  function expand(){
    expanded = true;
    if(window.popupAPI) window.popupAPI.resize(EXPANDED_W, EXPANDED_H);
    setTimeout(render, 0);
  }
  function collapse(){
    expanded = false;
    if(window.popupAPI) window.popupAPI.resize(BUBBLE_W, BUBBLE_H);
    setTimeout(render, 0);
  }
  function advance(){
    queue.shift();
    if(queue.length === 0){
      if(window.popupAPI) window.popupAPI.close();
    } else {
      render();
    }
  }

  if(window.popupAPI && window.popupAPI.onQuestionAdded){
    window.popupAPI.onQuestionAdded(function(data){
      if(!data || typeof data.text !== 'string') return;
      if(queue.some(function(q){ return q.qid === data.qid; })) return;
      if(queue.length >= MAX_QUEUE) queue.shift(); // 너무 많이 쌓이면 가장 오래된 것 drop
      queue.push({ qid: data.qid, text: data.text });
      render();
    });
  }

  render();
</script>
</body></html>`
}

function ensureQuestionPopupWindow() {
  if (questionPopupWindow && !questionPopupWindow.isDestroyed()) return questionPopupWindow
  const bounds = popupPositionFor(QUESTION_POPUP_BUBBLE_W, QUESTION_POPUP_BUBBLE_H)
  const popup = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,    // PPT focus 안 뺏기
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'popup-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  popup.setAlwaysOnTop(true, 'screen-saver')
  popup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeQuestionPopupHtml()))
  popup.once('ready-to-show', () => {
    if (!popup.isDestroyed()) popup.showInactive()
  })
  popup.on('closed', () => {
    if (questionPopupWindow === popup) questionPopupWindow = null
  })
  questionPopupWindow = popup
  return popup
}

function sendQuestionToPopup(popup, payload) {
  if (!popup || popup.isDestroyed()) return
  popup.webContents.send('popup-question-added', {
    text: String(payload.text).slice(0, 200),
    qid: typeof payload.qid === 'string' ? payload.qid : '',
  })
}

ipcMain.on('show-question-popup', (_, payload) => {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) return
  if (!popupModeActive) return
  const popup = ensureQuestionPopupWindow()
  // 페이지 로드 완료 전이면 한 번만 큐잉 후 발사
  if (popup.webContents.isLoading()) {
    popup.webContents.once('did-finish-load', () => sendQuestionToPopup(popup, payload))
  } else {
    sendQuestionToPopup(popup, payload)
  }
})

// 풍선창의 bubble ↔ expanded 사이즈 변경 — 우측 끝 위젯 옆 정렬 유지
ipcMain.on('popup-resize', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  if (!payload) return
  const w = Math.max(40, Math.min(720, Math.round(Number(payload.w) || 0)))
  const h = Math.max(40, Math.min(720, Math.round(Number(payload.h) || 0)))
  const bounds = popupPositionFor(w, h)
  win.setBounds(bounds)
})

ipcMain.on('popup-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.close()
})

// ── 강의 목록 백업 (localStorage 손실 시 복구용) ──────────────────────────
const coursesBackupPath = () => path.join(app.getPath('userData'), 'courses.json')

ipcMain.handle('read-courses-backup', async () => {
  try {
    const raw = await fs.promises.readFile(coursesBackupPath(), 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : null
  } catch { return null }
})

ipcMain.handle('write-courses-backup', async (_e, data) => {
  try {
    if (!Array.isArray(data)) return false
    const dir = app.getPath('userData')
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(coursesBackupPath(), JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch { return false }
})

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createLandingWindow()
})

// Cmd+Q 또는 앱 메뉴 종료 — 위젯이 떠 있으면 flush 후 quit
app.on('before-quit', (e) => {
  if (isAppQuitting) return
  if (widgetWindow && !widgetWindow.isDestroyed() && !widgetWindow._flushed) {
    // 라이브면 한 번 확인. 취소면 quit 중단 (isAppQuitting 도 reset).
    if (!confirmEndLiveSession(widgetWindow)) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    isAppQuitting = true
    flushSession('quit', () => {
      try {
        if (widgetWindow && !widgetWindow.isDestroyed()) {
          widgetWindow._flushed = true
          widgetWindow.destroy()
        }
      } finally {
        app.quit()
      }
    })
  } else {
    isAppQuitting = true
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!mainWindow && !widgetWindow) createLandingWindow()
})
