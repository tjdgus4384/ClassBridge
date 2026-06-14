const { contextBridge, ipcRenderer } = require('electron')

// 렌더러(Next.js 페이지)에서 window.electronAPI 로 접근
contextBridge.exposeInMainWorld('electronAPI', {
  openWidget: (roomId, ownerToken) => ipcRenderer.send('open-widget', { roomId, ownerToken }),
  closeWidget: () => ipcRenderer.send('close-widget'),
  toggleCompact: (compact) => ipcRenderer.send('toggle-compact', { compact }),
  // 라이브 모드는 미니 폭(288) + 본문 동적 높이, 검토는 풀(460×720) 복원.
  // 미니 모드는 main이 무시.
  setLiveSize: (payload) => ipcRenderer.send('set-live-size', payload),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  // 렌더러가 라이브 모드 진입/종료 시 호출 — main 이 ✕/Cmd+Q confirm 여부 판단
  setLiveState: (isLive) => ipcRenderer.send('set-live-state', !!isLive),
  // 메인이 종료 직전 호출 — 렌더러는 emit('session-end') 후 flushSessionDone() 회신
  onFlushSession: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('flush-session', handler)
    return () => ipcRenderer.removeListener('flush-session', handler)
  },
  flushSessionDone: () => ipcRenderer.send('flush-session-done'),
  // 강의 목록 백업 — userData/courses.json
  readCoursesBackup: () => ipcRenderer.invoke('read-courses-backup'),
  writeCoursesBackup: (data) => ipcRenderer.invoke('write-courses-backup', data),
  // ── popup_only 모드 ─────────────────────────────────────────────────────
  // 위젯창은 popup 모드 동안 52×52 고정. 말풍선/본문은 별도 BrowserWindow 로 관리.
  enterPopupMode: () => ipcRenderer.send('enter-popup-mode'),
  exitPopupMode: () => ipcRenderer.send('exit-popup-mode'),
  // 말풍선창 show/hide (style + count)
  showPopupBubble: (opts) => ipcRenderer.send('popup-show-bubble', opts || {}),
  hidePopupBubble: () => ipcRenderer.send('popup-hide-bubble'),
  // 본문 카드창 show/hide/update (text + currentIdx + total)
  showPopupCard: (opts) => ipcRenderer.send('popup-show-card', opts || {}),
  hidePopupCard: () => ipcRenderer.send('popup-hide-card'),
  // 말풍선 클릭 / 카드 액션 등 popup 창에서 발생한 이벤트 listen
  onPopupAction: (cb) => {
    const handler = (_e, action) => cb(action)
    ipcRenderer.on('popup-action', handler)
    return () => ipcRenderer.removeListener('popup-action', handler)
  },
  isElectron: true,
})
