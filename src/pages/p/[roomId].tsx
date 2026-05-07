import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { getSocket } from '@/lib/socket'
import { StudentCountChart, ReactionTimelineChart, Snapshot } from '@/components/Charts'

interface Question {
  id: string
  text: string
  timestamp: number
}

interface Reactions {
  green: number
  yellow: number
  red: number
}

interface ArchivedSession {
  id: string
  startedAt: number
  endedAt: number
  reactions: Reactions
  questionCount: number
  questions: Question[]
  peakStudentCount: number
  timeline: Snapshot[]
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

function formatDuration(start: number, end: number): string {
  const ms = Math.max(0, end - start)
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

// electronAPI 타입 선언은 src/lib/courseStore.ts의 declare global에서 단일 정의됨

// URL fragment에서 ownerToken을 꺼낸다 (#t=<hex32>)
function readOwnerTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.hash.match(/[#&]t=([a-f0-9]{32})/)
  return m ? m[1] : null
}

export default function ProfessorDashboard() {
  const router = useRouter()
  const { roomId, widget } = router.query as { roomId: string; widget?: string }

  const [mounted, setMounted] = useState(false)
  const [isElectron, setIsElectron] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [authError, setAuthError] = useState<string | null>(null)
  const [courseName, setCourseName] = useState<string | null>(null)
  const [isLive, setIsLive] = useState(false)
  const [starting, setStarting] = useState(false)
  const [reactions, setReactions] = useState<Reactions>({ green: 0, yellow: 0, red: 0 })
  const [questions, setQuestions] = useState<Question[]>([])
  const [studentCount, setStudentCount] = useState(0)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [newQuestionPulse, setNewQuestionPulse] = useState(false)
  const [archived, setArchived] = useState<ArchivedSession[]>([])
  const [historyOpen, setHistoryOpen] = useState(true) // 검토 모드에선 기본 펼침
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const isWidget = widget === '1' || isElectron

  // compact 초기값: ?compact=1 로 직접 접속할 때만 true, 기본은 큰 모드
  const [compact, setCompact] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const ownerTokenRef = useRef<string | null>(null)

  const socketRef = useRef(getSocket())

  useEffect(() => {
    setMounted(true)
    setIsElectron(!!window.electronAPI)
    setBaseUrl(window.location.origin)
    // 토큰: URL fragment 우선, 없으면 sessionStorage 폴백 (브라우저 새로고침 대비)
    const fromHash = readOwnerTokenFromHash()
    if (fromHash) {
      ownerTokenRef.current = fromHash
      if (typeof roomId === 'string') {
        try { sessionStorage.setItem(`cb-owner:${roomId}`, fromHash) } catch {}
      }
    } else if (typeof roomId === 'string') {
      try {
        const t = sessionStorage.getItem(`cb-owner:${roomId}`)
        if (t) ownerTokenRef.current = t
      } catch {}
    }
  }, [roomId])

  // ── Socket Setup ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return
    const socket = socketRef.current

    const onConnect = () => {
      setStatus('connected')
      socket.emit('join-room', {
        roomId,
        role: 'professor',
        ownerToken: ownerTokenRef.current,
      })
    }
    const onDisconnect = () => setStatus('disconnected')

    const onJoinError = ({ reason }: { reason: string }) => {
      setAuthError(reason)
      setStatus('disconnected')
    }

    const onRoomState = (data: {
      reactions: Reactions
      questions: Question[]
      studentCount: number
      sessionId?: string | null
      isLive?: boolean
      name?: string | null
      archivedSessions?: ArchivedSession[]
    }) => {
      setAuthError(null)
      setReactions(data.reactions)
      setQuestions(data.questions)
      setStudentCount(data.studentCount)
      setStatus('connected')
      if (typeof data.isLive === 'boolean') setIsLive(data.isLive)
      if (typeof data.name !== 'undefined') setCourseName(data.name)
      if (Array.isArray(data.archivedSessions)) setArchived(data.archivedSessions)
    }

    const onCourseRenamed = ({ name }: { name: string | null }) => setCourseName(name)
    const onSessionStarted = () => {
      setIsLive(true)
      setStarting(false)
      setReactions({ green: 0, yellow: 0, red: 0 })
      setQuestions([])
      setStudentCount(0)
    }
    const onSessionEnded = () => {
      setIsLive(false)
      // 종료된 회차의 archived는 다음 room-state 갱신 때 받음 — 미리 한 번 더 join해서 갱신 트리거
      if (typeof roomId === 'string') {
        socketRef.current.emit('join-room', {
          roomId, role: 'professor', ownerToken: ownerTokenRef.current,
        })
      }
    }

    const onReactionUpdate = (data: { reactions: Reactions }) => {
      setReactions(data.reactions)
    }

    const onNewQuestion = (data: { question: Question; questionCount: number }) => {
      setQuestions((prev) => [...prev, data.question])
      if (!questionsOpen) {
        setNewQuestionPulse(true)
        setTimeout(() => setNewQuestionPulse(false), 1500)
      }
    }

    const onQuestionDismissed = ({ questionId }: { questionId: string }) => {
      setQuestions((prev) => prev.filter((q) => q.id !== questionId))
    }

    const onStudentCount = (count: number) => setStudentCount(count)

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('join-error', onJoinError)
    socket.on('room-state', onRoomState)
    socket.on('course-renamed', onCourseRenamed)
    socket.on('reaction-update', onReactionUpdate)
    socket.on('new-question', onNewQuestion)
    socket.on('question-dismissed', onQuestionDismissed)
    socket.on('student-count', onStudentCount)
    socket.on('session-started', onSessionStarted)
    socket.on('session-ended', onSessionEnded)

    if (socket.connected) onConnect()

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('join-error', onJoinError)
      socket.off('room-state', onRoomState)
      socket.off('course-renamed', onCourseRenamed)
      socket.off('reaction-update', onReactionUpdate)
      socket.off('new-question', onNewQuestion)
      socket.off('question-dismissed', onQuestionDismissed)
      socket.off('student-count', onStudentCount)
      socket.off('session-started', onSessionStarted)
      socket.off('session-ended', onSessionEnded)
    }
  }, [roomId, questionsOpen])

  // ── Electron flush 핸들러 — 위젯 닫기/Cmd+Q 시 세션 종료 신호 emit ────
  useEffect(() => {
    if (!isElectron || !window.electronAPI?.onFlushSession) return
    const off = window.electronAPI.onFlushSession(() => {
      try {
        socketRef.current.emit('session-end', { courseId: roomId, roomId })
      } catch {}
      // 메인이 600ms 안전망을 가지고 있으니 조금 기다렸다가 ack
      setTimeout(() => {
        try { window.electronAPI?.flushSessionDone?.() } catch {}
      }, 80)
    })
    return () => { try { off?.() } catch {} }
  }, [isElectron, roomId])

  const dismissQuestion = useCallback((questionId: string) => {
    socketRef.current.emit('dismiss-question', { roomId, questionId })
  }, [roomId])

  const clearReactions = useCallback(() => {
    socketRef.current.emit('clear-reactions', { roomId })
  }, [roomId])

  const startSession = useCallback(() => {
    if (starting || isLive) return
    setStarting(true)
    socketRef.current.emit('session-start', { courseId: roomId, roomId }, (res?: { ok?: boolean; error?: string }) => {
      // 'session-started' broadcast가 setIsLive(true)+setStarting(false) 처리. 실패 시 롤백.
      if (!res?.ok) setStarting(false)
    })
    // 안전망 — 응답 없으면 5초 뒤 starting 해제
    setTimeout(() => setStarting(false), 5000)
  }, [roomId, isLive, starting])

  const endSession = useCallback(() => {
    if (!isLive) return
    socketRef.current.emit('session-end', { courseId: roomId, roomId })
    // setIsLive(false)는 onSessionEnded에서 처리됨
  }, [roomId, isLive])

  const handleToggleCompact = useCallback((val: boolean) => {
    setCompact(val)
    if (isElectron) window.electronAPI!.toggleCompact(val)
  }, [isElectron])

  // 라이브 종료되면 미니 모드 자동 해제
  useEffect(() => {
    if (!isLive && compact) handleToggleCompact(false)
  }, [isLive, compact, handleToggleCompact])

  // ── 비 Electron 차단 ──────────────────────────────────────────────────────
  if (mounted && !isElectron) {
    return (
      <>
        <Head><title>ClassBridge</title></Head>
        <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center">
          <h1 className="text-white text-2xl font-semibold mb-3">ClassBridge 앱 전용</h1>
          <p className="text-white/70 text-base">교수자 대시보드는 ClassBridge 앱에서만 사용할 수 있습니다.</p>
        </div>
      </>
    )
  }

  if (!mounted) return null

  // ── 인증 실패 화면 ─────────────────────────────────────────────────────────
  if (authError) {
    const msg =
      authError === 'unauthorized' ? '이 강의의 교수자 토큰이 일치하지 않습니다.' :
      authError === 'room_not_found' ? '강의를 찾을 수 없습니다. 코드가 잘못되었거나 만료되었을 수 있습니다.' :
      authError === 'invalid_room_id' ? '잘못된 강의 코드입니다.' :
      '강의 진입에 실패했습니다.'
    return (
      <>
        <Head><title>ClassBridge · 권한 없음</title></Head>
        <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center">
          <h1 className="text-white text-2xl font-semibold mb-3">접근할 수 없습니다</h1>
          <p className="text-white/70 text-base mb-8 max-w-sm leading-relaxed">{msg}</p>
          {isElectron && (
            <button
              onClick={() => window.electronAPI!.closeWidget()}
              className="text-white text-sm font-medium px-5 py-2.5 border border-white/20 rounded-lg hover:border-white/40 hover:bg-white/5 transition-all"
            >
              랜딩으로 돌아가기
            </button>
          )}
        </div>
      </>
    )
  }

  // ── Energy Bar calculation ──────────────────────────────────────────────
  const total = reactions.green + reactions.yellow + reactions.red
  const greenPct = total > 0 ? (reactions.green / total) * 100 : 0
  const yellowPct = total > 0 ? (reactions.yellow / total) * 100 : 0
  const redPct = total > 0 ? (reactions.red / total) * 100 : 0

  // Overall health score: 0–100
  const healthScore = total > 0
    ? Math.round((reactions.green * 100 + reactions.yellow * 50 + reactions.red * 0) / total)
    : -1

  const healthColor = healthScore >= 70 ? 'text-emerald-400' :
                      healthScore >= 40 ? 'text-amber-400' : 'text-rose-400'

  const studentUrl = baseUrl ? `${baseUrl}/s/${roomId}` : ''

  const copyLink = () => {
    if (studentUrl) navigator.clipboard.writeText(studentUrl)
  }

  // ── Compact (overlay) mode ──────────────────────────────────────────────
  if (compact) {
    // 에너지 점: 3개 점으로 현재 상태 표현
    const dominantColor =
      total === 0 ? 'bg-white/20'
      : redPct > 40 ? 'bg-rose-500'
      : yellowPct > 40 ? 'bg-amber-400'
      : 'bg-emerald-400'

    return (
      <>
        <Head><title>ClassBridge</title></Head>
        {/* 창 배경 그대로 — 콘텐츠만 */}
        <div
          className="w-screen h-screen flex items-center select-none"
          style={{ WebkitAppRegion: 'drag' } as any}
        >

              {/* 드래그 영역 + 상태 dot */}
              <div className="flex items-center gap-2 pl-4 pr-3">
                {/* 상태 표시 dot */}
                <div className={`w-2 h-2 rounded-full transition-colors duration-700 ${dominantColor}`} />
              </div>

              {/* 에너지 바 */}
              <div
                className="w-28 h-1.5 bg-white/[0.07] rounded-full overflow-hidden flex"
                style={{ WebkitAppRegion: 'no-drag' } as any}
              >
                {total > 0 && (
                  <>
                    <div className="bg-emerald-400 h-full transition-all duration-700 ease-out" style={{ width: `${greenPct}%` }} />
                    <div className="bg-amber-400 h-full transition-all duration-700 ease-out" style={{ width: `${yellowPct}%` }} />
                    <div className="bg-rose-500 h-full transition-all duration-700 ease-out" style={{ width: `${redPct}%` }} />
                  </>
                )}
              </div>

              {/* 구분선 */}
              <div className="w-px h-5 bg-white/[0.07] mx-3" />

              {/* 학생 수 */}
              <span
                className="text-white/40 text-xs font-medium tabular-nums pr-1"
                style={{ WebkitAppRegion: 'no-drag', letterSpacing: '0.02em' } as any}
              >
                {studentCount}
              </span>
              <svg className="w-3.5 h-3.5 text-white/25 mr-3" fill="currentColor" viewBox="0 0 20 20"
                style={{ WebkitAppRegion: 'no-drag' } as any}>
                <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
              </svg>

              {/* 구분선 */}
              <div className="w-px h-5 bg-white/[0.07] mr-3" />

              {/* 질문 버튼 */}
              <button
                onClick={() => { handleToggleCompact(false); setQuestionsOpen(true) }}
                className={`relative flex items-center justify-center w-7 h-7 rounded-full transition-colors
                  ${questions.length > 0 ? 'text-white/70 hover:text-white' : 'text-white/25 hover:text-white/50'}
                  ${newQuestionPulse ? 'animate-bounce' : ''}`}
                style={{ WebkitAppRegion: 'no-drag' } as any}
                title="질문 보기"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                {questions.length > 0 && (
                  <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 leading-none">
                    {questions.length > 9 ? '9+' : questions.length}
                  </span>
                )}
              </button>

              {/* 확장 버튼 */}
              <button
                onClick={() => handleToggleCompact(false)}
                className="flex items-center justify-center w-7 h-7 rounded-full text-white/20 hover:text-white/50 transition-colors mr-2"
                style={{ WebkitAppRegion: 'no-drag' } as any}
                title="전체 보기"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              </button>

        </div>{/* 필 끝 */}
      </>
    )
  }

  // 정렬: 최신 회차가 위로
  const sortedArchive = [...archived].sort((a, b) => b.startedAt - a.startedAt)

  return (
    <>
      <Head>
        <title>ClassBridge · 교수자 대시보드</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div
        className={`min-h-screen text-white relative ${isWidget ? 'bg-black/90 backdrop-blur-xl rounded-2xl' : 'bg-[#0d0d0d]'}`}
        style={isWidget ? { borderRadius: 16, overflow: 'hidden' } : {}}
      >
        {/* 라이브일 때 상단 1px LIVE 라인 — 시각적 모드 신호 */}
        {isLive && (
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-emerald-500/80 z-10" />
        )}

        {/* ── Top Bar ── */}
        <div
          className="border-b border-white/8 px-4 py-3 flex items-center justify-between"
          style={isWidget ? { WebkitAppRegion: 'drag' } as any : {}}
        >
          <div className="flex items-center gap-3 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
            {isWidget && <span className="text-white/30 text-base cursor-grab">⠿</span>}
            <div className="min-w-0">
              <div className="text-white text-sm font-semibold tracking-tight truncate">
                {courseName || 'ClassBridge'}
              </div>
              <div className="text-white/50 text-xs font-mono mt-0.5">#{roomId}</div>
            </div>
            {/* 모드 인디케이터 */}
            <div className="flex items-center gap-1.5 ml-2">
              {isLive ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-emerald-400 text-sm font-semibold tracking-tight">LIVE</span>
                  <span className="text-white/60 text-sm font-medium tabular-nums">· {studentCount}명</span>
                </>
              ) : (
                <>
                  <div className={`w-2 h-2 rounded-full ${
                    status === 'connected' ? 'bg-white/40' :
                    status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500'
                  }`} />
                  <span className="text-white/60 text-sm">
                    {status === 'connected' ? '수업 시작 전' : status === 'connecting' ? '연결 중...' : '연결 끊김'}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
            {isLive && (
              <>
                <button
                  onClick={endSession}
                  className="text-rose-400 hover:text-white hover:bg-rose-500 text-sm font-semibold px-3 py-1.5 rounded-lg border border-rose-500/40 hover:border-rose-500 transition-all"
                >
                  수업 종료
                </button>
                <button
                  onClick={() => handleToggleCompact(true)}
                  className="text-white/60 hover:text-white text-sm px-3 py-1.5 rounded-lg border border-white/15 hover:border-white/30 transition-all"
                >
                  미니
                </button>
              </>
            )}
            {isElectron && (
              <button
                onClick={() => window.electronAPI!.closeWidget()}
                className="text-white/50 hover:text-rose-400 text-sm px-3 py-1.5 rounded-lg border border-white/15 hover:border-rose-500/40 transition-all"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="max-w-2xl mx-auto px-6 py-7 space-y-8">

          {/* ── 검토 모드 전용 영역 ── */}
          {!isLive && (
            <section className="space-y-5">
              {/* 메인 CTA: 수업 시작 */}
              <button
                onClick={startSession}
                disabled={starting || status !== 'connected'}
                className="w-full py-5 rounded-2xl text-lg font-semibold bg-emerald-500 text-white hover:bg-emerald-400 active:bg-emerald-600 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                {starting ? '시작 중...' : '수업 시작'}
              </button>
              <p className="text-white/50 text-sm text-center -mt-2">
                시작 전엔 학생들 화면이 대기 상태로 보입니다.
              </p>
            </section>
          )}

          {/* ── 라이브 모드 전용: Energy Bar + 질문 ── */}
          {isLive && (
          <>
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white/70 text-sm font-semibold tracking-tight">수업 온도계</h2>
              <div className="flex items-center gap-3">
                {healthScore >= 0 && (
                  <span className={`text-sm font-semibold ${healthColor}`}>
                    {healthScore >= 70 ? '👍 순항 중' : healthScore >= 40 ? '⚠️ 주의' : '🆘 재설명 필요'}
                  </span>
                )}
                {total > 0 && (
                  <button
                    onClick={clearReactions}
                    className="text-white/50 hover:text-white text-sm px-2 py-1 rounded-md hover:bg-white/5 transition-all"
                  >
                    초기화
                  </button>
                )}
              </div>
            </div>

            <div className="h-7 bg-white/5 rounded-full overflow-hidden flex border border-white/8">
              {total === 0 ? (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-white/40 text-sm">아직 반응 없음</span>
                </div>
              ) : (
                <>
                  <div className="bg-emerald-500 h-full transition-all duration-700 ease-out flex items-center justify-center" style={{ width: `${greenPct}%` }}>
                    {greenPct > 10 && <span className="text-white text-sm font-semibold">{Math.round(greenPct)}%</span>}
                  </div>
                  <div className="bg-amber-400 h-full transition-all duration-700 ease-out flex items-center justify-center" style={{ width: `${yellowPct}%` }}>
                    {yellowPct > 10 && <span className="text-white text-sm font-semibold">{Math.round(yellowPct)}%</span>}
                  </div>
                  <div className="bg-rose-500 h-full transition-all duration-700 ease-out flex items-center justify-center" style={{ width: `${redPct}%` }}>
                    {redPct > 10 && <span className="text-white text-sm font-semibold">{Math.round(redPct)}%</span>}
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-5 mt-3 flex-wrap">
              {[
                { emoji: '🟢', label: '이해 완료', count: reactions.green, color: 'text-emerald-400' },
                { emoji: '🟡', label: '속도 조절', count: reactions.yellow, color: 'text-amber-400' },
                { emoji: '🔴', label: '재설명', count: reactions.red, color: 'text-rose-400' },
              ].map(({ emoji, label, count, color }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="text-base">{emoji}</span>
                  <span className="text-white/70 text-sm">{label}</span>
                  <span className={`text-sm font-mono font-semibold tabular-nums ${color}`}>{count}</span>
                </div>
              ))}
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-white/50 text-sm">총</span>
                <span className="text-white text-sm font-mono font-semibold tabular-nums">{total}</span>
              </div>
            </div>
          </section>

          {/* ── Questions ── */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => setQuestionsOpen((v) => !v)}
                className="flex items-center gap-2 group"
              >
                <h2 className="text-white/70 text-sm font-semibold tracking-tight group-hover:text-white transition-colors">
                  익명 질문
                </h2>
                <div className={`flex items-center gap-1.5 transition-all ${newQuestionPulse ? 'scale-110' : ''}`}>
                  <span className="text-lg">💬</span>
                  {questions.length > 0 && (
                    <span className="bg-rose-500 text-white text-xs rounded-full px-2 py-0.5 font-mono font-semibold min-w-[22px] text-center">
                      {questions.length}
                    </span>
                  )}
                </div>
                <span className="text-white/50 text-xs ml-1">
                  {questionsOpen ? '▲' : '▼'}
                </span>
              </button>
              {questions.length > 0 && questionsOpen && (
                <button
                  onClick={() => questions.forEach((q) => dismissQuestion(q.id))}
                  className="text-white/50 hover:text-white text-sm px-2 py-1 rounded-md hover:bg-white/5 transition-all"
                >
                  전체 삭제
                </button>
              )}
            </div>

            {questionsOpen && (
              <div className="space-y-2">
                {questions.length === 0 ? (
                  <div className="text-white/50 text-sm text-center py-8 border border-white/8 rounded-xl">
                    아직 질문이 없습니다
                  </div>
                ) : (
                  questions.map((q) => (
                    <div
                      key={q.id}
                      className="flex items-start gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 group"
                    >
                      <p className="flex-1 text-white text-base leading-relaxed">{q.text}</p>
                      <button
                        onClick={() => dismissQuestion(q.id)}
                        className="text-white/40 hover:text-white transition-colors text-xl leading-none mt-0.5 opacity-0 group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
          </>
          )}

          {/* ── 회차 히스토리 ── */}
          <section>
            <button
              onClick={() => setHistoryOpen(v => !v)}
              className="flex items-center gap-2 mb-3 group"
            >
              <h2 className="text-white/70 text-sm font-semibold tracking-tight group-hover:text-white transition-colors">
                지난 회차
              </h2>
              {sortedArchive.length > 0 && (
                <span className="bg-white/10 text-white/80 text-xs rounded-full px-2 py-0.5 font-mono font-semibold">
                  {sortedArchive.length}
                </span>
              )}
              <span className="text-white/50 text-xs ml-1">
                {historyOpen ? '▲' : '▼'}
              </span>
            </button>

            {historyOpen && (
              <div className="space-y-2">
                {sortedArchive.length === 0 ? (
                  <div className="text-white/50 text-sm text-center py-8 border border-white/8 rounded-xl">
                    아직 종료된 회차가 없습니다
                  </div>
                ) : (
                  sortedArchive.map((s, idx) => {
                    const num = sortedArchive.length - idx // 최신부터 N..1
                    const isOpen = openSessionId === s.id
                    const dur = formatDuration(s.startedAt, s.endedAt)
                    const totalReactions = s.reactions.green + s.reactions.yellow + s.reactions.red
                    return (
                      <div key={s.id} className="bg-white/[0.04] border border-white/10 rounded-xl overflow-hidden">
                        <button
                          onClick={() => setOpenSessionId(isOpen ? null : s.id)}
                          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/[0.03] transition-colors"
                        >
                          <div className="text-white/60 text-xs font-mono font-semibold w-10">
                            #{num}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-white text-sm font-medium">
                              {formatDateTime(s.startedAt)}
                            </div>
                            <div className="text-white/50 text-xs mt-0.5">
                              {dur} · 학생 최대 {s.peakStudentCount}명 · 리액션 {totalReactions}회 · 질문 {s.questionCount}개
                            </div>
                          </div>
                          <span className="text-white/40 text-sm">{isOpen ? '▲' : '▼'}</span>
                        </button>
                        {isOpen && (
                          <div className="border-t border-white/8 px-4 py-4 space-y-5 bg-black/20">
                            <StudentCountChart data={s.timeline || []} />
                            <ReactionTimelineChart data={s.timeline || []} />
                            <div>
                              <div className="text-white/70 text-sm font-medium mb-2">
                                질문 <span className="text-white/50 font-mono">({s.questions?.length || 0})</span>
                              </div>
                              {(!s.questions || s.questions.length === 0) ? (
                                <div className="text-white/40 text-sm py-3">질문이 없었습니다</div>
                              ) : (
                                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                                  {s.questions.map(q => (
                                    <div key={q.id} className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm leading-relaxed">
                                      {q.text}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </section>

          {/* ── Share / QR ── */}
          <section>
            <h2 className="text-white/70 text-sm font-semibold tracking-tight mb-3">학생 접속 링크</h2>
            <div className="bg-white/[0.04] border border-white/10 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <code className="flex-1 text-white text-sm font-mono break-all">
                  {studentUrl || `…/s/${roomId}`}
                </code>
                <button
                  onClick={copyLink}
                  className="text-white/70 hover:text-white text-sm px-3 py-1.5 border border-white/15 rounded-lg hover:border-white/30 transition-all whitespace-nowrap"
                >
                  복사
                </button>
              </div>
              <p className="text-white/50 text-sm">
                PPT QR 코드로 이 링크를 공유하거나, 학생에게 직접 전달하세요.
              </p>
            </div>
          </section>

        </div>
      </div>
    </>
  )
}
