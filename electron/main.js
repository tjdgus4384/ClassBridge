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
    transparent: true,                  // 미니 모드 backdrop-blur 작동 위해 transparent 유지.
    backgroundColor: '#00000000',       // popup 모드는 별도 솔리드 윈도우 (popupReturnWindow) 로 분리.
    alwaysOnTop: true,
    hasShadow: true,                    // 미니/풀 모드 자연스러운 그림자.
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

  // 위젯 이동 시 말풍선/카드 따라가게
  widgetWindow.on('move', () => {
    if (popupModeActive) reattachPopupWindowsToWidget()
  })

  widgetWindow.on('closed', () => {
    widgetWindow = null
    widgetClosing = false
    isLiveSession = false  // 다음 위젯 진입 시 stale 상태로 confirm 뜨지 않도록
    popupModeActive = false
    savedWidgetBounds = null
    // popup 관련 창 정리
    if (popupReturnWindow && !popupReturnWindow.isDestroyed()) popupReturnWindow.close()
    if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
    if (popupCardWindow && !popupCardWindow.isDestroyed()) popupCardWindow.close()
    popupReturnWindow = null
    popupBubbleWindow = null
    popupCardWindow = null
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
// 메인 위젯창은 transparent: true (미니 모드 backdrop-blur 작동).
// popup 모드 진입 시 메인 위젯은 hide() 하고, 별도 솔리드 44×44 popupReturnWindow 를
// 그 자리에 띄움. 말풍선/본문 카드도 별도 BrowserWindow.
// 모든 popup 창의 위치 anchor = 메인 위젯 (popup 모드 동안엔 popupReturnWindow) 의
// 왼쪽 옆.
const POPUP_TINY_W = 72
const POPUP_TINY_H = 72
const POPUP_GAP = 8                 // 위젯 ↔ 말풍선/카드 간 간격
const CARD_W = 312                  // 본문 280 + 양옆 16px 그림자 buffer
const CARD_DEFAULT_H = 110          // 카드 처음 등장 시 임시 높이 — ResizeObserver 가 조정
const CARD_MAX_H = 320
const BUBBLE_W = 72                 // 말풍선 (흰 원 + Sea Blue 배지) — 콘텐츠 36 + 그림자 buffer 18×2
const BUBBLE_H = 72
const RETURN_MARGIN = 20            // 화면 우상단에서 복귀 버튼 까지의 여백
let popupModeActive = false
let savedWidgetBounds = null
let popupBubbleWindow = null
let popupCardWindow = null
let popupReturnWindow = null        // popup 모드 동안만 — 화면 우상단 고정, hover 시 표시

const POPUP_RETURN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  -webkit-user-select:none;user-select:none;
  display:flex;align-items:center;justify-content:center;}
button{background:#0a0a0a;border:0;cursor:pointer;padding:0;
  width:36px;height:36px;border-radius:50%;
  color:rgba(255,255,255,0.85);
  display:flex;align-items:center;justify-content:center;
  opacity:0;
  transition:opacity 0.2s ease,transform 0.2s ease;
  box-shadow:0 4px 12px rgba(0,0,0,0.3);}
body:hover button{opacity:1;}
button:hover{color:#fff;transform:scale(1.05);}
svg{width:16px;height:16px;}
</style></head><body>
<button id="b" title="전체 보기로 복귀">
<svg fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24">
<path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>
</svg>
</button>
<script>
document.getElementById('b').onclick=function(){
  if(window.popupAPI&&window.popupAPI.returnClicked)window.popupAPI.returnClicked();
};
</script>
</body></html>`

function clampToDisplay(x, y, w, h, refBounds) {
  const display = screen.getDisplayMatching(refBounds || { x, y, width: w, height: h }).workArea
  const nx = Math.max(display.x, Math.min(x, display.x + display.width - w))
  const ny = Math.max(display.y, Math.min(y, display.y + display.height - h))
  return { x: nx, y: ny, width: w, height: h }
}

function setWidgetSizeAnchorRight(w, h) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (widgetClosing) return
  const cur = widgetWindow.getBounds()
  const right = cur.x + cur.width
  const target = clampToDisplay(right - w, cur.y, w, h, cur)
  widgetWindow.setResizable(true)
  widgetWindow.setMinimumSize(0, 0)
  widgetWindow.setMaximumSize(0, 0)
  widgetWindow.setBounds(target)
}

// 말풍선/카드 위치 — popup 모드면 popupReturnWindow 기준, 아니면 메인 widget 기준.
// verticalAlign 'center' (말풍선): 콘텐츠 중심을 anchor 중심에 맞춤.
// verticalAlign 'top' (카드): anchor 상단과 같은 y.
function popupPositionLeftOfWidget(w, h, verticalAlign = 'center') {
  const anchor = (popupReturnWindow && !popupReturnWindow.isDestroyed())
    ? popupReturnWindow
    : (widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow : null)
  const refBounds = anchor ? anchor.getBounds() : null
  let x, y
  if (refBounds) {
    x = refBounds.x - w - POPUP_GAP
    y = verticalAlign === 'top'
      ? refBounds.y
      : refBounds.y + Math.round((refBounds.height - h) / 2)
  } else {
    const d = screen.getPrimaryDisplay().workArea
    x = d.x + d.width - w - 60
    y = d.y + 30
  }
  return clampToDisplay(x, y, w, h, refBounds || { x, y, width: w, height: h })
}

// popup 모드의 복귀 버튼 창 — 화면 우상단 고정 (workArea 기준 margin 적용).
// 평소엔 button opacity 0 (안 보임), 윈도우 영역 hover 시 opacity 1.
// 위치 고정 (movable: false) — 위젯 위치와 무관.
function createPopupReturnWindow() {
  if (popupReturnWindow && !popupReturnWindow.isDestroyed()) return popupReturnWindow
  const display = screen.getPrimaryDisplay().workArea
  const x = display.x + display.width - POPUP_TINY_W - RETURN_MARGIN
  const y = display.y + RETURN_MARGIN
  popupReturnWindow = new BrowserWindow({
    width: POPUP_TINY_W, height: POPUP_TINY_H, x, y,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, hasShadow: false,
    resizable: false, movable: false,
    minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'popup-preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  })
  popupReturnWindow.setAlwaysOnTop(true, 'screen-saver')
  popupReturnWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(POPUP_RETURN_HTML))
  popupReturnWindow.once('ready-to-show', () => {
    if (!popupReturnWindow.isDestroyed()) popupReturnWindow.showInactive()
  })
  popupReturnWindow.on('closed', () => { popupReturnWindow = null })
  return popupReturnWindow
}

// 위젯 이동 시 말풍선/카드 따라가게
function reattachPopupWindowsToWidget() {
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) {
    const b = popupBubbleWindow.getBounds()
    const bounds = popupPositionLeftOfWidget(b.width, b.height, 'center')
    try { popupBubbleWindow.setBounds(bounds) } catch {}
  }
  if (popupCardWindow && !popupCardWindow.isDestroyed()) {
    const b = popupCardWindow.getBounds()
    const bounds = popupPositionLeftOfWidget(b.width, b.height, 'top')
    try { popupCardWindow.setBounds(bounds) } catch {}
  }
}

ipcMain.on('enter-popup-mode', () => {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetClosing) return
  if (popupModeActive) return
  popupModeActive = true
  savedWidgetBounds = widgetWindow.getBounds()
  createPopupReturnWindow()    // 솔리드 복귀 버튼 창 띄움 (메인 widget 자리)
  widgetWindow.hide()           // 메인 위젯은 hide (renderer state 는 그대로 유지)
})

ipcMain.on('exit-popup-mode', () => {
  if (!popupModeActive) return
  popupModeActive = false
  if (popupReturnWindow && !popupReturnWindow.isDestroyed()) popupReturnWindow.close()
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
  if (popupCardWindow && !popupCardWindow.isDestroyed()) popupCardWindow.close()
  popupReturnWindow = null
  popupBubbleWindow = null
  popupCardWindow = null
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.show()
  savedWidgetBounds = null
})

// popup 복귀 버튼 창에서 클릭 — 렌더러에 전달 (renderer 가 widgetMode='full' 로 전환)
ipcMain.on('popup-return-clicked', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('popup-action', 'return-clicked')
  }
})

// ── HTML escape (공용) ──
function escHtmlPopup(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

// ── 말풍선창 — 흰 원 + Sea Blue 배지 단일 스타일 ──
function makeBubbleHtml(initialCount) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0;padding:0;background:transparent;width:100vw;height:100vh;
  overflow:hidden;-webkit-user-select:none;user-select:none;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
#root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  cursor:pointer;}
.circle{position:relative;width:36px;height:36px;
  background:#fff;border-radius:50%;
  box-shadow:0 4px 12px rgba(0,0,0,0.22),0 1px 3px rgba(0,0,0,0.12);
  animation:cb-circle-in 0.32s cubic-bezier(0.34,1.56,0.64,1) both;
  transition:transform 0.15s ease;}
#root:hover .circle{transform:scale(1.06);}
.cnt{position:absolute;top:-4px;right:-4px;
  min-width:18px;height:18px;padding:0 5px;
  background:#28AAE1;color:#fff;border-radius:9px;
  font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;
  display:flex;align-items:center;justify-content:center;
  border:1.5px solid #fff;
  box-shadow:0 2px 4px rgba(0,0,0,0.2);}
@keyframes cb-circle-in{
  from{opacity:0;transform:scale(0.5);}
  to{opacity:1;transform:scale(1);}
}
</style></head>
<body>
<div id="root"></div>
<script>
var count = ${Number(initialCount) || 1};
var root = document.getElementById('root');
function render(){
  var n = count > 99 ? '99+' : count;
  root.innerHTML = '<div class="circle"><span class="cnt">' + n + '</span></div>';
}
root.addEventListener('click', function(){
  if(window.popupAPI && window.popupAPI.bubbleClicked) window.popupAPI.bubbleClicked();
});
if(window.popupAPI && window.popupAPI.onBubbleUpdate){
  window.popupAPI.onBubbleUpdate(function(d){
    if(d && typeof d.count === 'number') count = d.count;
    render();
  });
}
render();
</script>
</body></html>`
}

// ── 본문 카드창 — 폭 280 고정, 높이 가변 (ResizeObserver 가 main 에 요청) ──
// 헤더 행 없음. 본문 텍스트와 액션 버튼이 같은 flex 컨테이너 안.
// align-items: flex-end → 버튼이 본문 마지막 줄과 같은 수직선에.
function makeCardHtml(initialText, initialIdx, initialTotal) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
<style>
  *,*::before,*::after{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:transparent;width:100vw;height:100vh;
    overflow:hidden;-webkit-user-select:none;user-select:none;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  #card{position:fixed;left:16px;right:16px;top:16px;
    background:#fff;border-radius:14px;
    box-shadow:0 6px 16px rgba(0,0,0,0.20),0 1px 3px rgba(0,0,0,0.10);
    padding:14px 16px 14px 18px;
    display:flex;align-items:flex-end;gap:10px;
    animation:cb-card-in 0.3s cubic-bezier(0.2,0.9,0.3,1) both;}
  @keyframes cb-card-in{
    from{opacity:0;transform:translateX(18px) scale(0.96);}
    to{opacity:1;transform:translateX(0) scale(1);}
  }
  .text{flex:1;min-width:0;color:#171717;font-size:14px;font-weight:500;
    line-height:1.5;word-break:break-word;}
  .btn{flex-shrink:0;background:#0a0a0a;color:#fff;border:0;
    padding:5px 13px;border-radius:7px;
    font-size:12px;font-weight:600;cursor:pointer;
    transition:background 0.15s ease;line-height:1.3;letter-spacing:0.01em;}
  .btn:hover{background:#262626;}
  /* V 체크 — 마지막 질문 확인 시 원형 아이콘 버튼 */
  .btn.check{width:28px;height:28px;padding:0;border-radius:50%;
    display:inline-flex;align-items:center;justify-content:center;}
  .btn.check svg{width:14px;height:14px;}
</style></head>
<body>
<div id="card">
  <span class="text" id="text"></span>
  <button class="btn" id="btn"></button>
</div>
<script>
  var text = ${JSON.stringify(initialText)};
  var currentIdx = ${Number(initialIdx) || 0};
  var total = ${Number(initialTotal) || 1};
  var card = document.getElementById('card');
  var elText = document.getElementById('text');
  var elBtn = document.getElementById('btn');
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';

  function render(){
    var isLast = currentIdx >= total - 1;
    elText.textContent = text;
    if(isLast){
      elBtn.className = 'btn check';
      elBtn.innerHTML = CHECK_SVG;
      elBtn.setAttribute('aria-label','확인');
    } else {
      elBtn.className = 'btn';
      elBtn.textContent = '다음';
      elBtn.removeAttribute('aria-label');
    }
    requestAnimationFrame(notifyResize);
  }
  function notifyResize(){
    var rect = card.getBoundingClientRect();
    var h = Math.ceil(rect.height) + 32; // top:16 + bottom:16 buffer (그림자 fit)
    if(window.popupAPI && window.popupAPI.requestCardResize) window.popupAPI.requestCardResize(h);
  }
  elBtn.addEventListener('click', function(){
    if(window.popupAPI && window.popupAPI.cardAction) window.popupAPI.cardAction();
  });
  if(window.popupAPI && window.popupAPI.onCardUpdate){
    window.popupAPI.onCardUpdate(function(d){
      if(d && typeof d.text === 'string') text = d.text;
      if(d && typeof d.currentIdx === 'number') currentIdx = d.currentIdx;
      if(d && typeof d.total === 'number') total = d.total;
      render();
    });
  }
  render();
</script>
</body></html>`
}

function createTransparentPopupWindow(w, h, x, y) {
  const win = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: false,        // macOS 기본 윈도우 그림자/회색 테두리 제거
    roundedCorners: false,   // macOS frameless 디폴트 둥근 테두리 제거 (회색 outline 의 원인)
    resizable: true, minimizable: false, maximizable: false, skipTaskbar: true,
    focusable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'popup-preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  return win
}

function ensurePopupBubbleWindow(count) {
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) {
    popupBubbleWindow.webContents.send('popup-bubble-update', { count })
    return popupBubbleWindow
  }
  const bounds = popupPositionLeftOfWidget(BUBBLE_W, BUBBLE_H, 'center')
  const win = createTransparentPopupWindow(bounds.width, bounds.height, bounds.x, bounds.y)
  popupBubbleWindow = win
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeBubbleHtml(count)))
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive() })
  win.on('closed', () => { if (popupBubbleWindow === win) popupBubbleWindow = null })
  return win
}

function ensurePopupCardWindow(text, currentIdx, total) {
  if (popupCardWindow && !popupCardWindow.isDestroyed()) {
    popupCardWindow.webContents.send('popup-card-update', { text, currentIdx, total })
    return popupCardWindow
  }
  const bounds = popupPositionLeftOfWidget(CARD_W, CARD_DEFAULT_H, 'top')
  const win = createTransparentPopupWindow(bounds.width, bounds.height, bounds.x, bounds.y)
  popupCardWindow = win
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeCardHtml(text, currentIdx, total)))
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive() })
  win.on('closed', () => { if (popupCardWindow === win) popupCardWindow = null })
  return win
}

ipcMain.on('popup-show-bubble', (_, opts) => {
  // 말풍선은 popup_only 모드 전용 (mini 모드는 위젯 자체에 카운트 표시)
  if (!popupModeActive) return
  const count = Math.max(1, Math.min(9999, Number(opts && opts.count) || 1))
  if (popupCardWindow && !popupCardWindow.isDestroyed()) return
  ensurePopupBubbleWindow(count)
})

ipcMain.on('popup-hide-bubble', () => {
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
  popupBubbleWindow = null
})

ipcMain.on('popup-show-card', (_, opts) => {
  // 카드는 popup_only 모드 + mini 모드 (질문 클릭) 모두에서 등장 가능 — popupModeActive 체크 X
  const text = (opts && typeof opts.text === 'string') ? opts.text.slice(0, 500) : ''
  if (!text) return
  const currentIdx = Math.max(0, Math.round(Number(opts && opts.currentIdx) || 0))
  const total = Math.max(1, Math.round(Number(opts && opts.total) || 1))
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
  popupBubbleWindow = null
  ensurePopupCardWindow(text, currentIdx, total)
})

ipcMain.on('popup-hide-card', () => {
  if (popupCardWindow && !popupCardWindow.isDestroyed()) popupCardWindow.close()
  popupCardWindow = null
})

// 말풍선 클릭 — 렌더러에 알림 (렌더러가 카드 열기 처리)
ipcMain.on('popup-bubble-clicked', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('popup-action', 'bubble-clicked')
  }
})

// 카드 버튼 클릭 — 렌더러에 알림 (다음/확인)
ipcMain.on('popup-card-action', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('popup-action', 'card-action')
  }
})

// 카드 내부 콘텐츠 측정 결과 — 카드창 높이 조정
ipcMain.on('popup-card-resize', (_, payload) => {
  if (!popupCardWindow || popupCardWindow.isDestroyed()) return
  const h = Math.max(60, Math.min(CARD_MAX_H, Math.round(Number(payload && payload.h) || 0)))
  const bounds = popupPositionLeftOfWidget(CARD_W, h, 'top')
  try { popupCardWindow.setBounds(bounds) } catch {}
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
