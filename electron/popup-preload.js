// 질문 풍선창 전용 — bubble ↔ expanded 상태 토글 + 질문 queue 처리.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('popupAPI', {
  // bubble (44×44) ↔ expanded (~320×140) 토글 시 main 에 윈도우 사이즈 변경 요청.
  // 우측 끝은 위젯 옆에 고정. main 이 widget bounds 참조해서 x 보정.
  resize: (w, h) => ipcRenderer.send('popup-resize', { w, h }),
  // queue 다 비면 창 자체 닫기
  close: () => ipcRenderer.send('popup-close'),
  // main → popup: 새 질문 추가 알림
  onQuestionAdded: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('popup-question-added', handler)
    return () => ipcRenderer.removeListener('popup-question-added', handler)
  },
})
