// 가벼운 SVG 차트 — 의존성 추가 없이 직접 그림.
// timeline = [{ t, reactions: {green, yellow, red}, studentCount }]

import { useMemo } from 'react'

export type Snapshot = {
  t: number
  reactions: { green: number; yellow: number; red: number }
  studentCount: number
}

const VBOX_W = 600
const VBOX_H = 160
const PAD_X = 8
const PAD_Y = 12

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// ───────────────────────────────────────────────────────────────────────
// 학생 수 라인 차트
export function StudentCountChart({ data, color = '#a78bfa' }: {
  data: Snapshot[]
  color?: string
}) {
  const { points, areaPath, max, last, first } = useMemo(() => {
    if (data.length < 2) return { points: '', areaPath: '', max: 0, last: 0, first: 0 }
    const xs = data.map(d => d.t)
    const ys = data.map(d => d.studentCount)
    const tMin = xs[0], tMax = xs[xs.length - 1]
    const yMax = Math.max(1, ...ys)
    const xRange = tMax - tMin || 1
    const xy = data.map(d => {
      const x = PAD_X + ((d.t - tMin) / xRange) * (VBOX_W - 2 * PAD_X)
      const y = VBOX_H - PAD_Y - (d.studentCount / yMax) * (VBOX_H - 2 * PAD_Y)
      return [x, y]
    })
    const points = xy.map(([x, y]) => `${x},${y}`).join(' ')
    const areaPath =
      `M ${xy[0][0]},${VBOX_H - PAD_Y} ` +
      xy.map(([x, y]) => `L ${x},${y}`).join(' ') +
      ` L ${xy[xy.length - 1][0]},${VBOX_H - PAD_Y} Z`
    return {
      points,
      areaPath,
      max: yMax,
      last: ys[ys.length - 1],
      first: ys[0],
    }
  }, [data])

  if (data.length < 2) return <ChartEmpty />

  const peak = Math.max(...data.map(d => d.studentCount))
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-white/70 text-sm font-medium">학생 수 변화</div>
        <div className="text-white/50 text-xs">
          최대 <span className="text-white font-semibold">{peak}</span>명
        </div>
      </div>
      <div className="relative bg-white/[0.03] border border-white/8 rounded-lg p-2">
        <svg viewBox={`0 0 ${VBOX_W} ${VBOX_H}`} className="w-full h-32" preserveAspectRatio="none">
          <defs>
            <linearGradient id="studentGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* y-grid (max line) */}
          <line x1={PAD_X} x2={VBOX_W - PAD_X} y1={PAD_Y} y2={PAD_Y} stroke="rgba(255,255,255,0.06)" strokeDasharray="2 4" />
          <path d={areaPath} fill="url(#studentGrad)" />
          <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <TimeAxis first={data[0].t} last={data[data.length - 1].t} />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// 리액션 stacked area — 1분 단위 신규 리액션 수
export function ReactionTimelineChart({ data }: { data: Snapshot[] }) {
  const deltas = useMemo(() => {
    if (data.length < 2) return []
    return data.slice(1).map((s, i) => {
      const prev = data[i]
      const dg = Math.max(0, s.reactions.green - prev.reactions.green)
      const dy = Math.max(0, s.reactions.yellow - prev.reactions.yellow)
      const dr = Math.max(0, s.reactions.red - prev.reactions.red)
      return { t: s.t, green: dg, yellow: dy, red: dr, total: dg + dy + dr }
    })
  }, [data])

  const totals = useMemo(() => {
    const last = data[data.length - 1]?.reactions || { green: 0, yellow: 0, red: 0 }
    return last
  }, [data])

  if (deltas.length < 1) return <ChartEmpty />

  // y-max
  const yMax = Math.max(1, ...deltas.map(d => d.total))
  const tMin = deltas[0].t
  const tMax = deltas[deltas.length - 1].t
  const xRange = tMax - tMin || 1

  const greenPath: string[] = []
  const yellowPath: string[] = []
  const redPath: string[] = []
  // baseline (bottom)
  greenPath.push(`M ${PAD_X},${VBOX_H - PAD_Y}`)
  yellowPath.push(`M ${PAD_X},${VBOX_H - PAD_Y}`)
  redPath.push(`M ${PAD_X},${VBOX_H - PAD_Y}`)

  deltas.forEach((d) => {
    const x = PAD_X + ((d.t - tMin) / xRange) * (VBOX_W - 2 * PAD_X)
    const yG = VBOX_H - PAD_Y - (d.green / yMax) * (VBOX_H - 2 * PAD_Y)
    const yY = VBOX_H - PAD_Y - ((d.green + d.yellow) / yMax) * (VBOX_H - 2 * PAD_Y)
    const yR = VBOX_H - PAD_Y - ((d.green + d.yellow + d.red) / yMax) * (VBOX_H - 2 * PAD_Y)
    greenPath.push(`L ${x},${yG}`)
    yellowPath.push(`L ${x},${yY}`)
    redPath.push(`L ${x},${yR}`)
  })
  // close back to baseline
  const lastX = PAD_X + ((deltas[deltas.length - 1].t - tMin) / xRange) * (VBOX_W - 2 * PAD_X)
  ;[greenPath, yellowPath, redPath].forEach(p => {
    p.push(`L ${lastX},${VBOX_H - PAD_Y} Z`)
  })

  const totalSum = totals.green + totals.yellow + totals.red

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-white/70 text-sm font-medium">리액션 흐름</div>
        <div className="text-white/50 text-xs">
          총 <span className="text-white font-semibold">{totalSum}</span>회
        </div>
      </div>
      <div className="bg-white/[0.03] border border-white/8 rounded-lg p-2">
        <svg viewBox={`0 0 ${VBOX_W} ${VBOX_H}`} className="w-full h-32" preserveAspectRatio="none">
          {/* 빨강(가장 위) → 노랑 → 초록 순서로 그려야 stacked가 올바르게 누적 */}
          <path d={redPath.join(' ')} fill="rgba(244,63,94,0.7)" />
          <path d={yellowPath.join(' ')} fill="rgba(251,191,36,0.75)" />
          <path d={greenPath.join(' ')} fill="rgba(16,185,129,0.8)" />
        </svg>
        <TimeAxis first={tMin} last={tMax} />
      </div>
      <div className="flex items-center gap-4 mt-3 text-sm">
        <LegendDot color="bg-emerald-500" label="이해 완료" count={totals.green} />
        <LegendDot color="bg-amber-400" label="속도 조절" count={totals.yellow} />
        <LegendDot color="bg-rose-500" label="재설명" count={totals.red} />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
function TimeAxis({ first, last }: { first: number; last: number }) {
  return (
    <div className="flex justify-between mt-1 px-1 text-white/40 text-xs font-mono">
      <span>{formatTime(first)}</span>
      <span>{formatTime(last)}</span>
    </div>
  )
}

function LegendDot({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${color}`} />
      <span className="text-white/60">{label}</span>
      <span className="text-white font-mono font-semibold tabular-nums">{count}</span>
    </div>
  )
}

function ChartEmpty() {
  return (
    <div className="bg-white/[0.03] border border-white/8 rounded-lg py-8 text-center text-white/40 text-sm">
      데이터가 부족합니다
    </div>
  )
}
