import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
      transports: ['websocket'],   // polling 스킵 — 멀티 머신 환경에서 세션 불일치 방지
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
    })
  }
  return socket
}

export function destroySocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}
