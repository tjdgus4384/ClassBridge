// 가벼운 SVG 차트 — 의존성 추가 없이 직접 그림.
// Snapshot은 두 가지 형태를 받아준다:
//  - 신 모델: { t, counts: {green, yellow, red, none}, studentCount }
//  - 옛 모델: { t, reactions: {green, yellow, red}, studentCount }
// 새 차트는 counts(=현재 그 상태에 있는 학생 수) 기준으로 그림.

import { useMemo } from 'react'

type Counts = { green: number; yellow: number; red: number; none?: number }

export type Snapshot = {
  t: number
  counts?: Counts
  reactions?: Counts
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

function getCounts(s: Snapshot): { green: number; yellow: number; red: number } {
  const c = s.counts || s.reactions || { green: 0, yellow: 0, red: 0 }
  return { green: c.green || 0, yellow: c.yellow || 0, red: c.red || 0 }
}

// ───────────────────────────────────────────────────────────────────────
// 학생 수 차트 — step after (값은 다음 시점까지 유지). 경사 X 절벽 O.
export function StudentCountChart({ data, color = '#a78bfa' }: {
  data: Snapshot[]
  color?: string
}) {
  const { stepLine, areaPath } = useMemo(() => {
    if (data.length < 2) return { stepLine: '', areaPath: '' }
    const tMin = data[0].t
    const tMax = data[data.length - 1].t
    const xRange = tMax - tMin || 1
    const yMax = Math.max(1, ...data.map(d => d.studentCount || 0))
    const xOf = (t: number) => PAD_X + ((t - tMin) / xRange) * (VBOX_W - 2 * PAD_X)
    const yOf = (v: number) => VBOX_H - PAD_Y - (v / yMax) * (VBOX_H - 2 * PAD_Y)

    // step after: M x0,y0  → 각 다음 점에 대해 H xi V yi
    const lineCmds: string[] = []
    const areaCmds: string[] = []
    const x0 = xOf(data[0].t), y0 = yOf(data[0].studentCount || 0)
    lineCmds.push(`M ${x0},${y0}`)
    areaCmds.push(`M ${x0},${VBOX_H - PAD_Y}`, `L ${x0},${y0}`)
    for (let i = 1; i < data.length; i++) {
      const xi = xOf(data[i].t)
      const yi = yOf(data[i].studentCount || 0)
      lineCmds.push(`H ${xi}`, `V ${yi}`)
      areaCmds.push(`H ${xi}`, `V ${yi}`)
    }
    const lastX = xOf(data[data.length - 1].t)
    areaCmds.push(`L ${lastX},${VBOX_H - PAD_Y} Z`)
    return { stepLine: lineCmds.join(' '), areaPath: areaCmds.join(' ') }
  }, [data])

  if (data.length < 2) return <ChartEmpty />
  const peak = Math.max(...data.map(d => d.studentCount || 0))

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-white/70 text-sm font-medium">학생 수</div>
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
          <path d={areaPath} fill="url(#studentGrad)" />
          <path d={stepLine} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="miter" strokeLinecap="butt" />
        </svg>
        <TimeAxis first={data[0].t} last={data[data.length - 1].t} />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// 상태 분포 시계열 — counts(현재 그 상태인 학생 수)를 stacked area로
export function ReactionTimelineChart({ data }: { data: Snapshot[] }) {
  const series = useMemo(() => data.map(d => ({ t: d.t, ...getCounts(d) })), [data])

  // 가장 막혔던 순간 (red+yellow) — 메타 정보용
  const peakStuck = useMemo(() => {
    let max = 0
    for (const s of series) {
      const stuck = s.yellow + s.red
      if (stuck > max) max = stuck
    }
    return max
  }, [series])

  const peakRed = useMemo(() => Math.max(0, ...series.map(s => s.red)), [series])

  if (series.length < 2) return <ChartEmpty />

  const yMax = Math.max(1, ...series.map(s => s.green + s.yellow + s.red))
  const tMin = series[0].t
  const tMax = series[series.length - 1].t
  const xRange = tMax - tMin || 1

  const xOf = (t: number) => PAD_X + ((t - tMin) / xRange) * (VBOX_W - 2 * PAD_X)
  const yOf = (v: number) => VBOX_H - PAD_Y - (v / yMax) * (VBOX_H - 2 * PAD_Y)

  // step after stacked area — 각 색은 baseline에서 시작해서 stack-top까지 step.
  // baseline(아래)에서 위쪽 윤곽까지 step으로 따라가다 닫음.
  function stepArea(getTopValue: (s: typeof series[number]) => number) {
    const cmds: string[] = []
    const x0 = xOf(series[0].t)
    const y0 = yOf(getTopValue(series[0]))
    cmds.push(`M ${x0},${VBOX_H - PAD_Y}`, `L ${x0},${y0}`)
    for (let i = 1; i < series.length; i++) {
      const xi = xOf(series[i].t)
      const yi = yOf(getTopValue(series[i]))
      cmds.push(`H ${xi}`, `V ${yi}`)
    }
    const lastX = xOf(series[series.length - 1].t)
    cmds.push(`L ${lastX},${VBOX_H - PAD_Y} Z`)
    return cmds.join(' ')
  }

  const greenPath = stepArea(s => s.green)
  const yellowPath = stepArea(s => s.green + s.yellow)
  const redPath = stepArea(s => s.green + s.yellow + s.red)

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-white/70 text-sm font-medium">상태 분포</div>
        <div className="text-white/50 text-xs">
          {peakRed > 0 ? (
            <>최대 막힘 <span className="text-rose-400 font-semibold">{peakStuck}</span>명 (🔴 <span className="text-rose-400 font-semibold">{peakRed}</span>)</>
          ) : (
            <>최대 막힘 <span className="text-white font-semibold">{peakStuck}</span>명</>
          )}
        </div>
      </div>
      <div className="bg-white/[0.03] border border-white/8 rounded-lg p-2">
        <svg viewBox={`0 0 ${VBOX_W} ${VBOX_H}`} className="w-full h-32" preserveAspectRatio="none">
          <path d={redPath} fill="rgba(244,63,94,0.7)" />
          <path d={yellowPath} fill="rgba(251,191,36,0.75)" />
          <path d={greenPath} fill="rgba(16,185,129,0.8)" />
        </svg>
        <TimeAxis first={tMin} last={tMax} />
      </div>
      <div className="flex items-center gap-4 mt-3 text-sm">
        <LegendDot color="bg-emerald-500" label="이해 완료" />
        <LegendDot color="bg-amber-400" label="속도 조절" />
        <LegendDot color="bg-rose-500" label="재설명" />
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

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${color}`} />
      <span className="text-white/70">{label}</span>
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
