import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
      // websocket 우선 + polling 폴백 — 일부 캠퍼스 Wi-Fi 가 ws 차단해도 학생 접속 가능.
      // 단일 인스턴스 운영 (fly min_machines=1) 이라 polling sticky session 이슈 없음.
      transports: ['websocket', 'polling'],
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
