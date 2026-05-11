const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
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
function createLandingWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 640,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false,                // 콘텐츠 준비될 때까지 숨김 → 깜빡임 제거
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,           // Chromium sandbox 안에서 renderer 실행
    },
  })
  mainWindow.loadURL(SERVER_URL)
  mainWindow.once('ready-to-show', () => mainWindow.show())
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
    },
  })

  widgetWindow.setAlwaysOnTop(true, 'screen-saver')

  const hash = ownerToken ? `#t=${encodeURIComponent(ownerToken)}` : ''
  widgetWindow.loadURL(`${SERVER_URL}/p/${roomId}?widget=1${hash}`)
  widgetWindow.once('ready-to-show', () => widgetWindow && widgetWindow.show())

  // 닫히기 직전 — 세션 종료 신호 emit 후 destroy
  widgetWindow.on('close', (e) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    if (widgetWindow._flushed) return // 이미 flush 후 destroy 진행 중
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

ipcMain.on('open-external', (_, url) => shell.openExternal(url))

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
