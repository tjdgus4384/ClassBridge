import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { getSocket } from '@/lib/socket'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
type SessionPhase = 'connecting' | 'waiting' | 'live'
type ReactionType = 'green' | 'yellow' | 'red'

// 학생 디바이스 ID — localStorage에 영구 저장. 서버 측 dedupe 키.
function getStudentId(): string {
  if (typeof window === 'undefined') return ''
  const KEY = 'cb-sid'
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'sid-' + Math.random().toString(16).slice(2) + Date.now().toString(16)
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return 'sid-fallback-' + Date.now().toString(16)
  }
}

export default function StudentRemote() {
  const router = useRouter()
  const { roomId } = router.query as { roomId: string }

  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [phase, setPhase] = useState<SessionPhase>('connecting')
  const [courseName, setCourseName] = useState<string | null>(null)
  const [myState, setMyState] = useState<ReactionType | null>(null)
  const [questionText, setQuestionText] = useState('')
  const [questionSent, setQuestionSent] = useState(false)
  const [, setWakeLockActive] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const socketRef = useRef(getSocket())
  const studentIdRef = useRef<string>('')
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    studentIdRef.current = getStudentId()
  }, [])

  // ── Screen Wake Lock ────────────────────────────────────────────────────
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
        setWakeLockActive(true)
        wakeLockRef.current.addEventListener('release', () => setWakeLockActive(false))
      }
    } catch { /* graceful fallback */ }
  }, [])

  // ── Visibility API: re-acquire wake lock & reconnect ───────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock()
        const socket = socketRef.current
        if (!socket.connected) {
          socket.connect()
        } else if (roomId && studentIdRef.current) {
          // 재join은 동일 studentId로 — 서버에서 dedupe되므로 학생 수 +1 안 됨
          socket.emit('join-room', {
            roomId,
            role: 'student',
            studentId: studentIdRef.current,
          })
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [roomId, requestWakeLock])

  // ── Socket Setup ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return
    const socket = socketRef.current

    const doJoin = () => {
      if (!studentIdRef.current) return
      socket.emit('join-room', {
        roomId,
        role: 'student',
        studentId: studentIdRef.current,
      })
    }

    const onConnect = () => { setStatus('connected'); doJoin() }
    const onDisconnect = () => setStatus('disconnected')
    const onRoomJoined = (data: { myState?: ReactionType | null; name?: string | null }) => {
      setStatus('connected')
      setJoinError(null)
      setPhase('live')
      if (typeof data?.myState !== 'undefined') setMyState(data.myState ?? null)
      if (typeof data?.name !== 'undefined') setCourseName(data.name ?? null)
    }
    const onSessionWaiting = (data?: { name?: string | null }) => {
      setStatus('connected')
      setJoinError(null)
      setPhase('waiting')
      setMyState(null)
      if (data && typeof data.name !== 'undefined') setCourseName(data.name ?? null)
    }
    const onCourseRenamed = ({ name }: { name: string | null }) => setCourseName(name)
    const onSessionStarted = () => {
      // 새 회차 시작 — 다시 join
      doJoin()
    }
    const onSessionEnded = () => {
      setPhase('waiting')
      setQuestionText('')
      setMyState(null)
    }
    const onMyState = ({ state }: { state: ReactionType | null }) => setMyState(state)
    const onJoinError = ({ reason }: { reason: string }) => setJoinError(reason)
    const onRateLimited = ({ event }: { event: string }) => {
      if (event === 'question') setToast('질문은 5초에 한 번만 보낼 수 있습니다.')
      else setToast('잠시 후 다시 시도해 주세요.')
      setTimeout(() => setToast(null), 2500)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('room-joined', onRoomJoined)
    socket.on('session-waiting', onSessionWaiting)
    socket.on('session-started', onSessionStarted)
    socket.on('session-ended', onSessionEnded)
    socket.on('my-state', onMyState)
    socket.on('course-renamed', onCourseRenamed)
    socket.on('join-error', onJoinError)
    socket.on('rate-limited', onRateLimited)

    if (socket.connected) onConnect()

    requestWakeLock()

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('room-joined', onRoomJoined)
      socket.off('session-waiting', onSessionWaiting)
      socket.off('session-started', onSessionStarted)
      socket.off('session-ended', onSessionEnded)
      socket.off('my-state', onMyState)
      socket.off('course-renamed', onCourseRenamed)
      socket.off('join-error', onJoinError)
      socket.off('rate-limited', onRateLimited)
      wakeLockRef.current?.release()
    }
  }, [roomId, requestWakeLock])

  // ── Send Reaction (토글) ────────────────────────────────────────────────
  const sendReaction = useCallback((type: ReactionType) => {
    if (status !== 'connected' || phase !== 'live') return
    // 낙관 업데이트 — 서버 응답 'my-state' 받으면 보정
    setMyState(prev => prev === type ? null : type)
    socketRef.current.emit('reaction', { roomId, type })
  }, [status, phase, roomId])

  // ── Send Question ───────────────────────────────────────────────────────
  const sendQuestion = useCallback(() => {
    const trimmed = questionText.trim()
    if (!trimmed || status !== 'connected' || phase !== 'live') return
    socketRef.current.emit('question', { roomId, text: trimmed })
    setQuestionText('')
    setQuestionSent(true)
    setTimeout(() => setQuestionSent(false), 2000)
  }, [questionText, status, phase, roomId])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendQuestion()
    }
  }

  // ── Reaction config ─────────────────────────────────────────────────────
  const reactions: Array<{
    type: ReactionType
    emoji: string
    label: string
    sublabel: string
    bgIdle: string
    bgActive: string
  }> = [
    {
      type: 'green',
      emoji: '🟢',
      label: '이해 완료',
      sublabel: 'Keep Going',
      bgIdle: 'bg-emerald-500/15 border-emerald-500/30 hover:bg-emerald-500/25',
      bgActive: 'bg-emerald-500/40 border-emerald-400 ring-2 ring-emerald-400/60 shadow-lg shadow-emerald-500/30',
    },
    {
      type: 'yellow',
      emoji: '🟡',
      label: '속도 조절',
      sublabel: 'Slow Down',
      bgIdle: 'bg-amber-500/15 border-amber-500/30 hover:bg-amber-500/25',
      bgActive: 'bg-amber-500/40 border-amber-400 ring-2 ring-amber-400/60 shadow-lg shadow-amber-500/30',
    },
    {
      type: 'red',
      emoji: '🔴',
      label: '재설명 요청',
      sublabel: 'Hard Reset',
      bgIdle: 'bg-rose-500/15 border-rose-500/30 hover:bg-rose-500/25',
      bgActive: 'bg-rose-500/40 border-rose-400 ring-2 ring-rose-400/60 shadow-lg shadow-rose-500/30',
    },
  ]

  // ── 입장 실패 화면 ──────────────────────────────────────────────────────
  if (joinError) {
    const msg =
      joinError === 'room_not_found' ? '존재하지 않는 강의입니다. 코드를 다시 확인해 주세요.' :
      joinError === 'invalid_room_id' ? '잘못된 강의 코드입니다.' :
      joinError === 'invalid_student_id' ? '디바이스 ID가 만들어지지 않았습니다. 페이지를 새로고침해 주세요.' :
      joinError === 'session_full' ? '강의 정원이 가득 찼습니다 (최대 500명).' :
      '입장에 실패했습니다.'
    return (
      <>
        <Head><title>ClassBridge</title></Head>
        <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center">
          <h1 className="text-white text-xl font-semibold mb-3">입장할 수 없습니다</h1>
          <p className="text-white/70 text-base mb-8 max-w-xs leading-relaxed">{msg}</p>
          <button
            onClick={() => router.push('/')}
            className="text-white text-sm font-medium px-5 py-2.5 border border-white/20 rounded-lg hover:border-white/40 hover:bg-white/5 transition-all"
          >
            처음으로
          </button>
        </div>
      </>
    )
  }

  // ── 대기실 / 연결 중 화면 ──────────────────────────────────────────────
  // connecting 상태에서 라이브 메인이 잠깐 깜빡이지 않도록 같은 화면으로 처리.
  if (phase === 'waiting' || phase === 'connecting') {
    return (
      <>
        <Head>
          <title>ClassBridge · 대기 중</title>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
          <meta name="theme-color" content="#0a0a0a" />
        </Head>
        <div
          className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center select-none"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="relative flex items-center justify-center mb-8">
            <div className="absolute w-20 h-20 rounded-full bg-white/8 animate-ping" />
            <div className="w-3.5 h-3.5 rounded-full bg-white/60" />
          </div>
          {courseName ? (
            <>
              <h1 className="text-white text-2xl font-semibold mb-1">{courseName}</h1>
              <p className="text-white/40 text-xs font-mono tracking-widest uppercase mb-4">#{roomId}</p>
            </>
          ) : (
            <p className="text-white/60 text-sm font-mono tracking-widest uppercase mb-3">{roomId}</p>
          )}
          <p className="text-white text-lg font-medium mb-3">강의 시작 대기 중</p>
          <p className="text-white/60 text-sm max-w-xs leading-relaxed">
            교수님이 강의를 시작하면 자동으로 연결됩니다.
          </p>
          <div className="mt-12 flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
              status === 'connected' ? 'bg-emerald-400' :
              status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500'
            }`} />
            <span className="text-white/60 text-sm">
              {status === 'connected' ? '연결됨' : status === 'connecting' ? '연결 중...' : '연결 끊김'}
            </span>
          </div>
          <a href="/privacy" className="mt-8 text-white/40 hover:text-white/70 text-xs underline-offset-2 hover:underline">
            개인정보처리방침
          </a>
        </div>
      </>
    )
  }

  return (
    <>
      <Head>
        <title>ClassBridge</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>

      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-rose-500 text-white text-sm font-medium px-4 py-2.5 rounded-full shadow-lg">
          {toast}
        </div>
      )}

      <div className="min-h-screen bg-[#0a0a0a] flex flex-col select-none" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-6 pb-2 gap-3">
          <div className="min-w-0 flex-1">
            {courseName ? (
              <>
                <div className="text-white text-sm font-semibold truncate">{courseName}</div>
                <div className="text-white/40 text-xs font-mono tracking-widest uppercase">#{roomId}</div>
              </>
            ) : (
              <span className="text-white/60 text-sm font-mono tracking-widest uppercase">{roomId}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
              status === 'connected' ? 'bg-emerald-400' :
              status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500'
            }`} />
            <span className="text-white/60 text-sm">
              {status === 'connected' ? '연결됨' : status === 'connecting' ? '연결 중...' : '연결 끊김'}
            </span>
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 flex flex-col justify-center px-5 gap-7 max-w-sm mx-auto w-full">

          <div>
            <p className="text-white/60 text-sm uppercase tracking-widest mb-4 text-center font-medium">
              지금 내 상태
            </p>
            <div className="flex flex-col gap-3">
              {reactions.map(({ type, emoji, label, sublabel, bgIdle, bgActive }) => {
                const isActive = myState === type
                return (
                  <button
                    key={type}
                    onClick={() => sendReaction(type)}
                    disabled={status !== 'connected'}
                    className={`
                      relative flex items-center gap-4 px-5 py-5 rounded-2xl border transition-all duration-150
                      ${isActive ? bgActive : bgIdle}
                      ${status !== 'connected' ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    <span className="text-3xl">{emoji}</span>
                    <div className="text-left flex-1">
                      <div className="text-white text-base font-semibold">{label}</div>
                      <div className="text-white/60 text-sm mt-0.5">{sublabel}</div>
                    </div>
                    {isActive && (
                      <span className="text-white/90 text-xs font-semibold tracking-wide">
                        선택됨
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="border-t border-white/8" />

          <div>
            <p className="text-white/60 text-sm uppercase tracking-widest mb-3 font-medium">
              익명 질문
            </p>
            <div className="relative">
              <textarea
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value.slice(0, 50))}
                onKeyDown={handleKeyDown}
                placeholder="질문을 입력하세요 (50자 이내)"
                disabled={status !== 'connected'}
                rows={3}
                className="
                  w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3
                  text-white text-base placeholder-white/40 resize-none outline-none
                  focus:border-white/30 focus:bg-white/[0.08] transition-colors
                  disabled:opacity-30 disabled:cursor-not-allowed
                "
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <span className={`text-sm font-mono ${questionText.length >= 45 ? 'text-amber-400' : 'text-white/50'}`}>
                  {questionText.length}/50
                </span>
              </div>
            </div>
            <button
              onClick={sendQuestion}
              disabled={!questionText.trim() || status !== 'connected'}
              className="
                mt-2 w-full py-3.5 rounded-xl text-base font-semibold transition-all duration-150
                bg-white/15 border border-white/15 text-white
                hover:bg-white/20 hover:border-white/25 active:bg-white/25
                disabled:opacity-30 disabled:cursor-not-allowed
              "
            >
              {questionSent ? '✓ 전송됨' : '질문 전송'}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-6 text-center space-y-1">
          <p className="text-white/50 text-sm">ClassBridge · 익명 보장</p>
          <a href="/privacy" className="inline-block text-white/40 hover:text-white/70 text-xs underline-offset-2 hover:underline">
            개인정보처리방침
          </a>
        </div>
      </div>
    </>
  )
}
