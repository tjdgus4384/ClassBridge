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
  isElectron: true,
})
