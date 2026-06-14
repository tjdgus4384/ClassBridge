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
    hasShadow: false,                   // macOS 의 시스템 그림자가 흰빛 halo 로 비쳐 이중 박스처럼 보이는 문제 해소
    roundedCorners: false,              // macOS 디폴트 둥근 모서리 outline 제거 — CSS borderRadius 가 처리
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
    // vibrancy 는 widget destroy 와 함께 자동 해제됨
    // 말풍선/카드 정리
    if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
    if (popupCardWindow && !popupCardWindow.isDestroyed()) popupCardWindow.close()
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
// 위젯창은 popup 모드 동안 52×52 고정. 말풍선/본문 카드는 별도 BrowserWindow 로 관리.
// 말풍선/카드 위치: 위젯창 왼쪽 옆에 anchor.
// popup 위젯 크기 — 정사각형 작게. transparent: true 가 작은 크기에서 작동 안 하는
// macOS 제약은 popup 진입 시 setVibrancy('hud') 동적 토글로 회피 (Windows 는
// setBackgroundMaterial('acrylic')). 다른 모드 (mini/full) 는 영향 없음.
const POPUP_TINY_W = 44
const POPUP_TINY_H = 44
const POPUP_GAP = 8                 // 위젯 ↔ 말풍선/카드 간 간격
const CARD_W = 312                  // 본문 280 + 양옆 16px 그림자 buffer
const CARD_DEFAULT_H = 140          // 카드 처음 등장 시 임시 높이 — ResizeObserver 가 조정
const CARD_MAX_H = 320
let popupModeActive = false
let savedWidgetBounds = null
let popupBubbleWindow = null
let popupCardWindow = null

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

// 말풍선/카드 위치 — 위젯 왼쪽 옆 (우측 끝 = 위젯.x - GAP).
// verticalAlign 'center' (말풍선): 콘텐츠가 위젯 세로 중심선에 오게.
// verticalAlign 'top' (카드): 위젯 상단과 같은 y.
function popupPositionLeftOfWidget(w, h, verticalAlign = 'center') {
  const widgetBounds = (widgetWindow && !widgetWindow.isDestroyed())
    ? widgetWindow.getBounds()
    : null
  let x, y
  if (widgetBounds) {
    x = widgetBounds.x - w - POPUP_GAP
    if (verticalAlign === 'top') {
      y = widgetBounds.y
    } else {
      // center — 콘텐츠 중심을 위젯 중심에 맞춤
      y = widgetBounds.y + Math.round((widgetBounds.height - h) / 2)
    }
  } else {
    const d = screen.getPrimaryDisplay().workArea
    x = d.x + d.width - w - 60
    y = d.y + 30
  }
  return clampToDisplay(x, y, w, h, widgetBounds || { x, y, width: w, height: h })
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

// popup 진입 시 macOS 네이티브 frosted material (vibrancy) 또는 Windows acrylic 켜기
// — 44×44 같은 작은 transparent 윈도우가 솔리드 backdrop 으로 떨어지는 문제 회피.
// 다른 모드 (mini/full) 는 vibrancy 끈 상태로 기존 CSS bg-black/65 backdrop-blur 그대로 사용.
function applyPopupVibrancy(on) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (process.platform === 'darwin') {
    try { widgetWindow.setVibrancy(on ? 'hud' : null) } catch {}
  } else if (process.platform === 'win32') {
    try { widgetWindow.setBackgroundMaterial(on ? 'acrylic' : 'none') } catch {}
  }
}

ipcMain.on('enter-popup-mode', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (widgetClosing) return
  if (popupModeActive) return
  popupModeActive = true
  savedWidgetBounds = widgetWindow.getBounds()
  applyPopupVibrancy(true)
  setWidgetSizeAnchorRight(POPUP_TINY_W, POPUP_TINY_H)
})

ipcMain.on('exit-popup-mode', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (!popupModeActive) return
  popupModeActive = false
  applyPopupVibrancy(false)
  // 말풍선/카드 정리
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
  if (popupCardWindow && !popupCardWindow.isDestroyed()) popupCardWindow.close()
  popupBubbleWindow = null
  popupCardWindow = null
  const targetW = savedWidgetBounds?.width || MINI_W
  const targetH = savedWidgetBounds?.height || LIVE_TEMP_HEIGHT
  setWidgetSizeAnchorRight(targetW, targetH)
  savedWidgetBounds = null
})

// ── HTML escape (공용) ──
function escHtmlPopup(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

// ── 말풍선창 — 3가지 스타일 (balloon / pill / bell) inline JS 분기 ──
// 윈도우 사이즈 = 콘텐츠 + 그림자 buffer (각 변 ~14-16px). 그림자가 잘리지 않게.
// 콘텐츠는 flex 로 중앙 정렬되며 buffer 영역은 transparent (사용자 입장에선 안 보임).
const BUBBLE_DIMENSIONS = {
  balloon: { w: 124, h: 70 },
  pill:    { w: 168, h: 64 },
  bell:    { w: 68, h: 68 },
}

function makeBubbleHtml(initialStyle, initialCount) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
<style>
  *,*::before,*::after{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:transparent;width:100vw;height:100vh;
    overflow:hidden;-webkit-user-select:none;user-select:none;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  #root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    cursor:pointer;}

  /* A. classic-balloon */
  .balloon{position:relative;background:#fff;color:#171717;border-radius:14px;
    padding:7px 11px;
    box-shadow:0 5px 14px rgba(0,0,0,0.22),0 1px 3px rgba(0,0,0,0.10);
    display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;
    animation:cb-balloon-in 0.45s cubic-bezier(0.34,1.56,0.64,1) both;}
  .balloon::after{content:'';position:absolute;right:-7px;top:50%;
    transform:translateY(-50%);width:0;height:0;border-style:solid;
    border-width:7px 0 7px 8px;border-color:transparent transparent transparent #fff;}
  .balloon .ic{font-size:15px;line-height:1;}
  .balloon .cnt{background:#ef4444;color:#fff;border-radius:8px;padding:1px 6px;
    font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;}
  .balloon .lbl{color:rgba(0,0,0,0.5);font-size:12px;}
  @keyframes cb-balloon-in{
    0%{opacity:0;transform:translateX(10px) scale(0.7);}
    60%{opacity:1;transform:translateX(-2px) scale(1.06);}
    100%{opacity:1;transform:translateX(0) scale(1);}
  }

  /* B. attention-pill */
  .pill{background:rgba(10,10,10,0.85);backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px);
    border:1px solid rgba(255,255,255,0.08);color:#fff;border-radius:18px;
    padding:7px 12px;display:flex;align-items:center;gap:8px;
    font-size:12px;font-weight:600;
    box-shadow:0 4px 12px rgba(0,0,0,0.32);
    animation:cb-pill-in 0.42s cubic-bezier(0.2,0.9,0.3,1) both,
              cb-pill-glow 2.2s ease-in-out infinite;}
  .pill .ic{font-size:13px;line-height:1;}
  .pill .lbl{letter-spacing:0.01em;}
  .pill .cnt{background:#ef4444;color:#fff;min-width:18px;height:18px;border-radius:9px;
    display:flex;align-items:center;justify-content:center;font-size:10.5px;
    font-weight:700;padding:0 5px;font-variant-numeric:tabular-nums;}
  @keyframes cb-pill-in{
    from{opacity:0;transform:translateX(24px);}
    to{opacity:1;transform:translateX(0);}
  }
  @keyframes cb-pill-glow{
    0%,100%{box-shadow:0 4px 12px rgba(0,0,0,0.32),0 0 0 0 rgba(239,68,68,0);}
    50%{box-shadow:0 4px 12px rgba(0,0,0,0.32),0 0 0 4px rgba(239,68,68,0.18);}
  }

  /* C. bouncing-bell — 새 질문 도착할 때마다 한 번만 흔들림 */
  .bell-wrap{position:relative;width:36px;height:36px;display:flex;
    align-items:center;justify-content:center;background:rgba(10,10,10,0.92);
    border-radius:50%;box-shadow:0 3px 10px rgba(0,0,0,0.28);
    animation:cb-bell-in 0.32s ease-out both;}
  .bell-wrap svg{width:20px;height:20px;color:#fbbf24;transform-origin:top center;}
  .bell-wrap.swing svg{animation:cb-bell-swing 0.85s ease-in-out;}
  .bell-wrap .cnt{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;
    min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;
    justify-content:center;font-size:10.5px;font-weight:700;padding:0 4px;
    border:2px solid rgba(10,10,10,0.92);font-variant-numeric:tabular-nums;}
  @keyframes cb-bell-swing{
    0%,100%{transform:rotate(0);}
    20%{transform:rotate(14deg);}
    40%{transform:rotate(-14deg);}
    60%{transform:rotate(9deg);}
    80%{transform:rotate(-5deg);}
  }
  @keyframes cb-bell-in{from{opacity:0;transform:scale(0.55);}to{opacity:1;transform:scale(1);}}
</style></head>
<body>
<div id="root"></div>
<script>
  var style = ${JSON.stringify(initialStyle)};
  var count = ${Number(initialCount) || 1};
  var root = document.getElementById('root');

  function render(){
    var n = count > 99 ? '99+' : count;
    var html = '';
    if(style === 'balloon'){
      html = '<div class="balloon"><span class="ic">💬</span>' +
        (count > 1 ? '<span class="cnt">' + n + '</span>' : '<span class="lbl">새 질문</span>') +
        '</div>';
    } else if(style === 'pill'){
      html = '<div class="pill"><span class="ic">💬</span>' +
        '<span class="lbl">새 질문</span>' +
        '<span class="cnt">' + n + '</span></div>';
    } else if(style === 'bell'){
      html = '<div class="bell-wrap" id="bw">' +
        '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>' +
        '<span class="cnt">' + n + '</span></div>';
    }
    root.innerHTML = html;
  }
  // 종 흔들림 1회 트리거 — class swing 을 잠깐 추가했다가 제거.
  // CSS animation 은 class 가 적용된 동안만 작동, 끝나면 멈춤.
  function triggerBellSwing(){
    if(style !== 'bell') return;
    var bw = document.getElementById('bw');
    if(!bw) return;
    bw.classList.remove('swing');
    // reflow 강제 — class 재추가 시 애니메이션 다시 시작
    void bw.offsetWidth;
    bw.classList.add('swing');
  }
  root.addEventListener('click', function(){
    if(window.popupAPI && window.popupAPI.bubbleClicked) window.popupAPI.bubbleClicked();
  });
  if(window.popupAPI && window.popupAPI.onBubbleUpdate){
    window.popupAPI.onBubbleUpdate(function(d){
      var newCount = (d && typeof d.count === 'number') ? d.count : count;
      var styleChanged = (d && typeof d.style === 'string' && d.style !== style);
      var countIncreased = newCount > count;
      if(d && typeof d.style === 'string') style = d.style;
      if(d && typeof d.count === 'number') count = newCount;
      render();
      // 새 질문 도착 (count 증가) 또는 스타일 변경 시 종 한 번 흔들림
      if(countIncreased || styleChanged) {
        requestAnimationFrame(triggerBellSwing);
      }
    });
  }
  render();
  // 최초 등장 시에도 종 한 번 흔들림
  requestAnimationFrame(triggerBellSwing);
</script>
</body></html>`
}

// ── 본문 카드창 — 폭 280 고정, 높이 가변 (ResizeObserver 가 main 에 요청) ──
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
    padding:13px 15px 12px;display:flex;flex-direction:column;gap:10px;
    animation:cb-card-in 0.3s cubic-bezier(0.2,0.9,0.3,1) both;}
  @keyframes cb-card-in{
    from{opacity:0;transform:translateX(18px) scale(0.96);}
    to{opacity:1;transform:translateX(0) scale(1);}
  }
  .head{display:flex;align-items:center;gap:6px;
    color:rgba(0,0,0,0.45);font-size:11px;font-weight:600;letter-spacing:0.02em;}
  .head .dot{width:6px;height:6px;border-radius:50%;background:#10b981;}
  .text{color:#171717;font-size:14px;font-weight:500;line-height:1.5;
    word-break:break-word;}
  .act{display:flex;justify-content:flex-end;margin-top:2px;}
  .btn{background:#0a0a0a;color:#fff;border:0;padding:7px 16px;border-radius:8px;
    font-size:12.5px;font-weight:600;cursor:pointer;transition:background 0.15s ease;
    letter-spacing:0.01em;}
  .btn:hover{background:#262626;}
</style></head>
<body>
<div id="card">
  <div class="head"><span class="dot"></span><span id="cnt"></span></div>
  <div class="text" id="text"></div>
  <div class="act"><button class="btn" id="btn"></button></div>
</div>
<script>
  var text = ${JSON.stringify(initialText)};
  var currentIdx = ${Number(initialIdx) || 0};
  var total = ${Number(initialTotal) || 1};
  var card = document.getElementById('card');
  var elText = document.getElementById('text');
  var elCnt = document.getElementById('cnt');
  var elBtn = document.getElementById('btn');

  function render(){
    var isLast = currentIdx >= total - 1;
    elText.textContent = text;
    elCnt.textContent = total > 1 ? ((currentIdx + 1) + ' / ' + total) : '질문';
    elBtn.textContent = isLast ? '확인' : '다음';
    // resize 알림 — 다음 frame 에 (텍스트 layout 완료 후)
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
  // 본문 카드 어느 영역이든 클릭 시 close 는 아니고 — 명시적 버튼만.
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

function ensurePopupBubbleWindow(style, count) {
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) {
    // 사이즈만 갱신 (스타일 변경 시 사이즈도 달라짐)
    const dim = BUBBLE_DIMENSIONS[style] || BUBBLE_DIMENSIONS.balloon
    const bounds = popupPositionLeftOfWidget(dim.w, dim.h, 'center')
    try { popupBubbleWindow.setBounds(bounds) } catch {}
    popupBubbleWindow.webContents.send('popup-bubble-update', { style, count })
    return popupBubbleWindow
  }
  const dim = BUBBLE_DIMENSIONS[style] || BUBBLE_DIMENSIONS.balloon
  const bounds = popupPositionLeftOfWidget(dim.w, dim.h)
  const win = createTransparentPopupWindow(bounds.width, bounds.height, bounds.x, bounds.y)
  popupBubbleWindow = win
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeBubbleHtml(style, count)))
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
  if (!popupModeActive) return
  const style = (opts && typeof opts.style === 'string' && BUBBLE_DIMENSIONS[opts.style]) ? opts.style : 'balloon'
  const count = Math.max(1, Math.min(9999, Number(opts && opts.count) || 1))
  // 카드창 떠 있으면 말풍선은 안 띄움 (사용자가 본문 보는 중)
  if (popupCardWindow && !popupCardWindow.isDestroyed()) return
  ensurePopupBubbleWindow(style, count)
})

ipcMain.on('popup-hide-bubble', () => {
  if (popupBubbleWindow && !popupBubbleWindow.isDestroyed()) popupBubbleWindow.close()
  popupBubbleWindow = null
})

ipcMain.on('popup-show-card', (_, opts) => {
  if (!popupModeActive) return
  const text = (opts && typeof opts.text === 'string') ? opts.text.slice(0, 500) : ''
  const currentIdx = Math.max(0, Math.round(Number(opts && opts.currentIdx) || 0))
  const total = Math.max(1, Math.round(Number(opts && opts.total) || 1))
  // 말풍선 떠 있으면 닫음 (카드가 같은 자리에 등장)
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
