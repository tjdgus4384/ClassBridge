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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  mainWindow.loadURL(SERVER_URL)
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
    transparent: false,
    backgroundColor: '#0a0a0a',
    alwaysOnTop: true,
    hasShadow: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  widgetWindow.setAlwaysOnTop(true, 'screen-saver')

  const hash = ownerToken ? `#t=${encodeURIComponent(ownerToken)}` : ''
  widgetWindow.loadURL(`${SERVER_URL}/p/${roomId}?widget=1${hash}`)

  // 닫히기 직전 — 세션 종료 신호 emit 후 destroy
  widgetWindow.on('close', (e) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    if (widgetWindow._flushed) return // 이미 flush 후 destroy 진행 중
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

// 미니 모드 고정 크기
const MINI_W = 288
const MINI_H = 52

ipcMain.on('toggle-compact', (_, { compact }) => {
  if (!widgetWindow) return
  if (compact) {
    widgetWindow.setResizable(false)
    widgetWindow.setSize(MINI_W, MINI_H, true)
  } else {
    widgetWindow.setResizable(true)
    widgetWindow.setSize(460, 720, true)
  }
})

ipcMain.on('open-external', (_, url) => shell.openExternal(url))

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
