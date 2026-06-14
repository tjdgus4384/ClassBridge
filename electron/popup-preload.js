// 질문 풍선창 (popup) 전용 — IPC 노출 최소화.
// main 의 data: URL 로딩 HTML 안에서 호출됨.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('popupAPI', {
  // ✕ 버튼 — 이 풍선만 닫음
  dismiss: () => ipcRenderer.send('popup-dismiss'),
  // ▢ 버튼 — 전체 풍선 닫고 메인 위젯을 전체 보기로 되돌림
  revertToWidget: () => ipcRenderer.send('popup-revert-to-widget'),
})
