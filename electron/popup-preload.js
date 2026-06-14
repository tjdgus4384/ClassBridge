// 말풍선창 + 본문 카드창 공용 preload — 양쪽 다 popupAPI 로 접근.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('popupAPI', {
  // ── 말풍선창 → main ──
  bubbleClicked: () => ipcRenderer.send('popup-bubble-clicked'),
  // ── 카드창 → main ──
  cardAction: () => ipcRenderer.send('popup-card-action'),
  requestCardResize: (h) => ipcRenderer.send('popup-card-resize', { h: Math.round(Number(h) || 0) }),
  // ── 복귀 버튼 창 → main ──
  returnClicked: () => ipcRenderer.send('popup-return-clicked'),
  // ── main → 말풍선창 (style, count 갱신) ──
  onBubbleUpdate: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('popup-bubble-update', handler)
    return () => ipcRenderer.removeListener('popup-bubble-update', handler)
  },
  // ── main → 카드창 (text, currentIdx, total 갱신) ──
  onCardUpdate: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('popup-card-update', handler)
    return () => ipcRenderer.removeListener('popup-card-update', handler)
  },
})
