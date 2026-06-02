// 운영자 전용 메트릭 페이지 — 토큰 보호 (/admin?key=<ADMIN_TOKEN>).
// 익명 데이터만 표시: 카운트, 시간대별 추이, 최근 에러 로그.
// 학생 개인정보 / 질문 본문 등은 절대 노출하지 않음.

import { useEffect, useState, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

interface LiveSnapshot {
  totalCourses: number
  liveSessions: number
  studentDevices: number
  studentSockets: number
  profSockets: number
}

interface DailyCounters {
  dateKey: string
  coursesCreated: number
  sessionsStarted: number
  sessionsEnded: number
  studentJoins: number
  reactions: number
  questions: number
  errors: number
  warnings: number
}

interface LifetimeCounters {
  coursesCreated: number
  sessionsStarted: number
  studentJoins: number
  reactions: number
  questions: number
}

interface TimePoint {
  t: number
  totalCourses: number
  liveSessions: number
  studentDevices: number
  studentSockets: number
  profSockets: number
}

interface LogEntry {
  t: string
  level: string
  event: string
  [k: string]: unknown
}

interface MetricsResp {
  now: number
  uptimeMs: number
  serverVersion?: string | null
  live: LiveSnapshot
  daily: DailyCounters
  lifetime: LifetimeCounters
  timeseries: TimePoint[]
  recentLogs: LogEntry[]
  ipConnCount: { unique: number }
  redisConnected: boolean
}

const POLL_MS = 5000

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}일 ${h}시간`
  if (h > 0) return `${h}시간 ${m}분`
  return `${m}분`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function Admin() {
  const router = useRouter()
  const [token, setToken] = useState<string>('')
  const [tokenInput, setTokenInput] = useState<string>('')
  const [data, setData] = useState<MetricsResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // URL ?key= 에서 토큰 수령. sessionStorage 로도 백업.
  useEffect(() => {
    if (!router.isReady) return
    const fromQuery = typeof router.query.key === 'string' ? router.query.key : ''
    if (fromQuery) {
      setToken(fromQuery)
      try { sessionStorage.setItem('cb-admin-key', fromQuery) } catch {}
    } else {
      try {
        const saved = sessionStorage.getItem('cb-admin-key')
        if (saved) setToken(saved)
      } catch {}
    }
  }, [router.isReady, router.query.key])

  // poll
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const fetchOnce = async () => {
      setLoading(true)
      try {
        const r = await fetch(`/admin/metrics?key=${encodeURIComponent(token)}`, {
          cache: 'no-store',
        })
        if (r.status === 401) {
          setError('unauthorized')
          setData(null)
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          return
        }
        if (!r.ok) { setError(`HTTP ${r.status}`); return }
        const j = await r.json()
        if (!cancelled) {
          setData(j)
          setError(null)
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'fetch failed'
        if (!cancelled) setError(msg)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchOnce()
    pollRef.current = setInterval(fetchOnce, POLL_MS)
    return () => {
      cancelled = true
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [token])

  // 토큰 없으면 입력 폼
  if (!token) {
    return (
      <>
        <Head>
          <title>ClassBridge Admin</title>
          <meta name="robots" content="noindex,nofollow" />
        </Head>
        <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
          <div className="w-full max-w-sm bg-white/[0.04] border border-white/10 rounded-2xl p-6">
            <h1 className="text-white text-lg font-semibold mb-4">관리자 인증</h1>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) setToken(tokenInput.trim()) }}
              placeholder="ADMIN_TOKEN"
              className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder-white/40 text-base focus:outline-none focus:border-white/40 mb-3 font-mono"
              autoFocus
            />
            <button
              onClick={() => tokenInput.trim() && setToken(tokenInput.trim())}
              disabled={!tokenInput.trim()}
              className="w-full py-3 rounded-xl text-base font-semibold bg-white text-black hover:bg-white/90 transition-all disabled:opacity-30"
            >
              열기
            </button>
          </div>
        </div>
      </>
    )
  }

  if (error === 'unauthorized') {
    return (
      <>
        <Head><title>ClassBridge Admin</title><meta name="robots" content="noindex,nofollow" /></Head>
        <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6 text-center">
          <div className="max-w-sm">
            <h1 className="text-white text-xl font-semibold mb-3">인증 실패</h1>
            <p className="text-white/60 text-sm mb-6">토큰이 올바르지 않거나 서버에 ADMIN_TOKEN 이 설정되어 있지 않습니다.</p>
            <button
              onClick={() => {
                setToken('')
                setTokenInput('')
                try { sessionStorage.removeItem('cb-admin-key') } catch {}
              }}
              className="text-white/70 hover:text-white text-sm px-4 py-2 border border-white/20 rounded-lg"
            >
              다시 입력
            </button>
          </div>
        </div>
      </>
    )
  }

  if (!data) {
    return (
      <>
        <Head><title>ClassBridge Admin</title><meta name="robots" content="noindex,nofollow" /></Head>
        <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center text-white/50 text-sm">
          연결 중...
        </div>
      </>
    )
  }

  const { live, daily, lifetime, timeseries, recentLogs, uptimeMs, redisConnected, ipConnCount, serverVersion } = data

  return (
    <>
      <Head>
        <title>ClassBridge Admin</title>
        <meta name="robots" content="noindex,nofollow" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-7">

          {/* 헤더 */}
          <div className="flex items-baseline justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">ClassBridge Admin</h1>
              <p className="text-white/50 text-sm mt-1">
                uptime {fmtUptime(uptimeMs)} · redis {redisConnected ? '✓' : '✗'}
                {serverVersion && ` · v${serverVersion}`} · 폴링 5초
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-white/40">
              {loading && <span>refreshing…</span>}
              <button
                onClick={() => {
                  setToken('')
                  setTokenInput('')
                  try { sessionStorage.removeItem('cb-admin-key') } catch {}
                }}
                className="text-white/40 hover:text-white/80 px-2 py-1 border border-white/10 rounded"
              >
                logout
              </button>
            </div>
          </div>

          {/* 실시간 카드 */}
          <section>
            <h2 className="text-white/60 text-xs uppercase tracking-widest mb-3">지금 (LIVE)</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Card label="라이브 회차" value={live.liveSessions} accent="emerald" />
              <Card label="동시 학생 (디바이스)" value={live.studentDevices} accent="white" />
              <Card label="학생 socket" value={live.studentSockets} muted />
              <Card label="교수 socket" value={live.profSockets} accent="white" />
              <Card label="전체 강의 (살아있음)" value={live.totalCourses} muted />
            </div>
          </section>

          {/* Today */}
          <section>
            <h2 className="text-white/60 text-xs uppercase tracking-widest mb-3">
              오늘 (KST · {daily.dateKey})
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="새 강의" value={daily.coursesCreated} accent="white" />
              <Card label="회차 시작" value={daily.sessionsStarted} accent="white" />
              <Card label="회차 종료" value={daily.sessionsEnded} muted />
              <Card label="학생 join" value={daily.studentJoins} accent="white" />
              <Card label="reaction" value={daily.reactions} muted />
              <Card label="질문" value={daily.questions} accent="white" />
              <Card label="warn" value={daily.warnings} accent={daily.warnings > 0 ? 'amber' : 'muted'} />
              <Card label="error" value={daily.errors} accent={daily.errors > 0 ? 'rose' : 'muted'} />
            </div>
          </section>

          {/* 시계열 차트 */}
          <section>
            <h2 className="text-white/60 text-xs uppercase tracking-widest mb-3">
              최근 24h · 5분 단위 ({timeseries.length} 포인트)
            </h2>
            <Chart data={timeseries} />
          </section>

          {/* Lifetime */}
          <section>
            <h2 className="text-white/60 text-xs uppercase tracking-widest mb-3">
              누적 (서버 부팅 후, uniqueIP {ipConnCount.unique})
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Card label="강의 생성" value={lifetime.coursesCreated} muted />
              <Card label="회차 시작" value={lifetime.sessionsStarted} muted />
              <Card label="학생 join" value={lifetime.studentJoins} muted />
              <Card label="reaction" value={lifetime.reactions} muted />
              <Card label="질문" value={lifetime.questions} muted />
            </div>
          </section>

          {/* 최근 로그 */}
          <section>
            <h2 className="text-white/60 text-xs uppercase tracking-widest mb-3">
              최근 warn/error (최대 50개)
            </h2>
            {recentLogs.length === 0 ? (
              <div className="text-white/40 text-sm text-center py-6 border border-white/10 rounded-xl">
                기록된 경고/에러 없음 ✓
              </div>
            ) : (
              <div className="border border-white/10 rounded-xl overflow-hidden">
                <div className="max-h-[400px] overflow-y-auto divide-y divide-white/5">
                  {[...recentLogs].reverse().map((entry, i) => (
                    <div key={i} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                      <span className={
                        entry.level === 'error'
                          ? 'text-rose-400 font-mono text-xs w-12 shrink-0'
                          : 'text-amber-400 font-mono text-xs w-12 shrink-0'
                      }>
                        {entry.level}
                      </span>
                      <span className="text-white/40 font-mono text-xs w-20 shrink-0 tabular-nums">
                        {fmtTime(new Date(entry.t).getTime())}
                      </span>
                      <span className="text-white font-mono text-xs shrink-0">{entry.event}</span>
                      <span className="text-white/50 text-xs font-mono truncate">
                        {Object.entries(entry)
                          .filter(([k]) => !['t', 'level', 'event'].includes(k))
                          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                          .join(' ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

        </div>
      </div>
    </>
  )
}

function Card({
  label, value, accent = 'white', muted = false,
}: {
  label: string
  value: number
  accent?: 'white' | 'emerald' | 'amber' | 'rose' | 'muted'
  muted?: boolean
}) {
  const colorMap: Record<string, string> = {
    white: 'text-white',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    rose: 'text-rose-400',
    muted: 'text-white/40',
  }
  const valueColor = muted ? colorMap.muted : colorMap[accent]
  return (
    <div className="bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3">
      <div className="text-white/50 text-xs mb-1">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${valueColor}`}>{value.toLocaleString()}</div>
    </div>
  )
}

// 단순 SVG 시계열 — 학생/세션/교수 3개 라인
function Chart({ data }: { data: TimePoint[] }) {
  if (data.length < 2) {
    return (
      <div className="bg-white/[0.02] ring-1 ring-white/[0.06] rounded-xl py-10 text-center text-white/35 text-sm">
        포인트가 더 모이면 차트가 표시됩니다 (5분 단위 누적)
      </div>
    )
  }
  const W = 800
  const H = 200
  const PAD_L = 0
  const PAD_R = 0
  const PAD_T = 10
  const PAD_B = 6

  const tMin = data[0].t
  const tMax = data[data.length - 1].t
  const xRange = tMax - tMin || 1
  const yMax = Math.max(
    2,
    ...data.map(d => Math.max(d.studentDevices, d.liveSessions, d.profSockets))
  )
  const xOf = (t: number) => PAD_L + ((t - tMin) / xRange) * (W - PAD_L - PAD_R)
  const yOf = (v: number) => H - PAD_B - (v / yMax) * (H - PAD_T - PAD_B)

  const pathFor = (key: 'studentDevices' | 'liveSessions' | 'profSockets') => {
    const cmds: string[] = []
    cmds.push(`M ${xOf(data[0].t)},${yOf(data[0][key])}`)
    for (let i = 1; i < data.length; i++) {
      cmds.push(`L ${xOf(data[i].t)},${yOf(data[i][key])}`)
    }
    return cmds.join(' ')
  }

  return (
    <div className="bg-white/[0.02] ring-1 ring-white/[0.06] rounded-xl overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" preserveAspectRatio="none" style={{ height: 200 }}>
        <line x1={0} x2={W} y1={H - PAD_B} y2={H - PAD_B} stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
        {[0.25, 0.5, 0.75].map(p => (
          <line key={p} x1={0} x2={W} y1={yOf(yMax * p)} y2={yOf(yMax * p)}
                stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" strokeDasharray="2 4" />
        ))}
        <path d={pathFor('studentDevices')} fill="none" stroke="#34d399" strokeWidth="1.5" />
        <path d={pathFor('liveSessions')} fill="none" stroke="#fbbf24" strokeWidth="1.5" />
        <path d={pathFor('profSockets')} fill="none" stroke="#fb7185" strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between px-3 py-1.5 text-white/35 text-xs font-mono border-t border-white/[0.04]">
        <span>{fmtTime(tMin)}</span>
        <span>peak {yMax}</span>
        <span>{fmtTime(tMax)}</span>
      </div>
      <div className="px-3 pb-3 flex items-center gap-4 text-xs">
        <Legend color="bg-emerald-400" label="동시 학생" />
        <Legend color="bg-amber-400" label="라이브 회차" />
        <Legend color="bg-rose-400" label="교수 socket" />
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-white/60">{label}</span>
    </div>
  )
}
