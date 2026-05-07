import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { getSocket } from '@/lib/socket'

// Cooldown in seconds between reactions
const REACTION_COOLDOWN = 30

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export default function StudentRemote() {
  const router = useRouter()
  const { roomId } = router.query as { roomId: string }

  type SessionPhase = 'connecting' | 'waiting' | 'live' | 'ended'

  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [phase, setPhase] = useState<SessionPhase>('connecting')
  const [cooldown, setCooldown] = useState(0) // seconds remaining
  const [lastReaction, setLastReaction] = useState<'green' | 'yellow' | 'red' | null>(null)
  const [questionText, setQuestionText] = useState('')
  const [questionSent, setQuestionSent] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const socketRef = useRef(getSocket())
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Screen Wake Lock ────────────────────────────────────────────────────
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
        setWakeLockActive(true)
        wakeLockRef.current.addEventListener('release', () => {
          setWakeLockActive(false)
        })
      }
    } catch {
      // Wake lock not supported or denied — graceful fallback
    }
  }, [])

  // ── Visibility API: re-acquire wake lock & reconnect ───────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock()
        const socket = socketRef.current
        if (!socket.connected) {
          socket.connect()
        } else if (roomId) {
          socket.emit('join-room', { roomId, role: 'student' })
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

    const onConnect = () => {
      setStatus('connected')
      socket.emit('join-room', { roomId, role: 'student' })
    }
    const onDisconnect = () => setStatus('disconnected')
    const onRoomJoined = () => { setStatus('connected'); setJoinError(null); setPhase('live') }
    const onSessionWaiting = () => { setStatus('connected'); setJoinError(null); setPhase('waiting') }
    const onSessionStarted = () => {
      // 대기실에서 자동으로 활성 화면으로 전환 — 새 회차에 join 시도
      socket.emit('join-room', { roomId, role: 'student' })
    }
    const onSessionEnded = () => {
      // 활성 → 대기실로 전환. 쿨다운/입력 상태는 정리.
      setPhase('waiting')
      setQuestionText('')
      setLastReaction(null)
    }
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
    socket.on('join-error', onJoinError)
    socket.on('rate-limited', onRateLimited)

    if (socket.connected) {
      onConnect()
    }

    requestWakeLock()

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('room-joined', onRoomJoined)
      socket.off('session-waiting', onSessionWaiting)
      socket.off('session-started', onSessionStarted)
      socket.off('session-ended', onSessionEnded)
      socket.off('join-error', onJoinError)
      socket.off('rate-limited', onRateLimited)
      wakeLockRef.current?.release()
    }
  }, [roomId, requestWakeLock])

  // ── Cooldown Timer ──────────────────────────────────────────────────────
  const startCooldown = useCallback(() => {
    setCooldown(REACTION_COOLDOWN)
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
    cooldownTimerRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownTimerRef.current!)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [])

  useEffect(() => () => { if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current) }, [])

  // ── Send Reaction ───────────────────────────────────────────────────────
  const sendReaction = useCallback((type: 'green' | 'yellow' | 'red') => {
    if (cooldown > 0 || status !== 'connected') return
    const socket = socketRef.current
    socket.emit('reaction', { roomId, type })
    setLastReaction(type)
    startCooldown()
  }, [cooldown, status, roomId, startCooldown])

  // ── Send Question ───────────────────────────────────────────────────────
  const sendQuestion = useCallback(() => {
    const trimmed = questionText.trim()
    if (!trimmed || status !== 'connected') return
    const socket = socketRef.current
    socket.emit('question', { roomId, text: trimmed })
    setQuestionText('')
    setQuestionSent(true)
    setTimeout(() => setQuestionSent(false), 2000)
  }, [questionText, status, roomId])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendQuestion()
    }
  }

  // ── Reaction config ─────────────────────────────────────────────────────
  const reactions = [
    {
      type: 'green' as const,
      emoji: '🟢',
      label: '이해 완료',
      sublabel: 'Keep Going',
      bg: 'bg-emerald-500/20 border-emerald-500/40 hover:bg-emerald-500/30 active:bg-emerald-500/50',
      selected: 'ring-2 ring-emerald-400',
    },
    {
      type: 'yellow' as const,
      emoji: '🟡',
      label: '속도 조절',
      sublabel: 'Slow Down',
      bg: 'bg-amber-500/20 border-amber-500/40 hover:bg-amber-500/30 active:bg-amber-500/50',
      selected: 'ring-2 ring-amber-400',
    },
    {
      type: 'red' as const,
      emoji: '🔴',
      label: '재설명 요청',
      sublabel: 'Hard Reset',
      bg: 'bg-rose-500/20 border-rose-500/40 hover:bg-rose-500/30 active:bg-rose-500/50',
      selected: 'ring-2 ring-rose-400',
    },
  ]

  // ── 입장 실패 화면 ──────────────────────────────────────────────────────
  if (joinError) {
    const msg =
      joinError === 'room_not_found' ? '존재하지 않는 강의입니다. 코드를 다시 확인해 주세요.' :
      joinError === 'invalid_room_id' ? '잘못된 강의 코드입니다.' :
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

  // ── 대기실 화면 (강의 시작 전 / 종료 후) ────────────────────────────────
  if (phase === 'waiting') {
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
          {/* 부드러운 펄스 점 */}
          <div className="relative flex items-center justify-center mb-8">
            <div className="absolute w-20 h-20 rounded-full bg-white/8 animate-ping" />
            <div className="w-3.5 h-3.5 rounded-full bg-white/60" />
          </div>
          <p className="text-white/60 text-sm font-mono tracking-widest uppercase mb-3">{roomId}</p>
          <h1 className="text-white text-2xl font-semibold mb-4">강의 시작 대기 중</h1>
          <p className="text-white/70 text-base max-w-xs leading-relaxed">
            교수님이 강의를 시작하면 자동으로 연결됩니다.<br/>이 페이지를 닫지 마세요.
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
          <a
            href="/privacy"
            className="mt-8 text-white/40 hover:text-white/70 text-xs underline-offset-2 hover:underline"
          >
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

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 pt-6 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-white/60 text-sm font-mono tracking-widest uppercase">
              {roomId}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
              status === 'connected' ? 'bg-emerald-400' :
              status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500'
            }`} />
            <span className="text-white/60 text-sm">
              {status === 'connected' ? '연결됨' : status === 'connecting' ? '연결 중...' : '연결 끊김'}
            </span>
          </div>
        </div>

        {/* ── Main Content ── */}
        <div className="flex-1 flex flex-col justify-center px-5 gap-7 max-w-sm mx-auto w-full">

          {/* ── Reaction Section ── */}
          <div>
            <p className="text-white/60 text-sm uppercase tracking-widest mb-4 text-center font-medium">
              수업 온도
            </p>
            <div className="flex flex-col gap-3">
              {reactions.map(({ type, emoji, label, sublabel, bg, selected }) => (
                <button
                  key={type}
                  onClick={() => sendReaction(type)}
                  disabled={cooldown > 0 || status !== 'connected'}
                  className={`
                    relative flex items-center gap-4 px-5 py-5 rounded-2xl border transition-all duration-150
                    ${bg}
                    ${lastReaction === type && cooldown > 0 ? selected : ''}
                    ${cooldown > 0 || status !== 'connected' ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  <span className="text-3xl">{emoji}</span>
                  <div className="text-left">
                    <div className="text-white text-base font-semibold">{label}</div>
                    <div className="text-white/60 text-sm mt-0.5">{sublabel}</div>
                  </div>
                  {lastReaction === type && cooldown > 0 && (
                    <div className="ml-auto text-white text-sm font-mono font-semibold">
                      {cooldown}s
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Cooldown notice */}
            {cooldown > 0 && (
              <p className="text-white/60 text-sm text-center mt-3">
                {cooldown}초 후 다시 전송 가능합니다
              </p>
            )}
          </div>

          {/* ── Divider ── */}
          <div className="border-t border-white/8" />

          {/* ── Question Section ── */}
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

        {/* ── Footer ── */}
        <div className="px-5 pb-6 text-center space-y-1">
          <p className="text-white/50 text-sm">
            ClassBridge · 익명 보장
          </p>
          <a
            href="/privacy"
            className="inline-block text-white/40 hover:text-white/70 text-xs underline-offset-2 hover:underline"
          >
            개인정보처리방침
          </a>
        </div>
      </div>
    </>
  )
}
