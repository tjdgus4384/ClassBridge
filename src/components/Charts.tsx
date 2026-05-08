// 가벼운 SVG 차트 — 의존성 추가 없이 직접 그림.
// 응답자 수 절대값을 stacked area로. y축은 응답 max에 맞춰 stack이 충분히 차오름.
// 학생 수 정보는 헤더로 분리. 그래디언트 X — 단색 + 얇은 윗 stroke.

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
const PAD_X = 0
const PAD_TOP = 8
const PAD_BOTTOM = 6

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function decompose(s: Snapshot): { green: number; yellow: number; red: number; none: number } {
  const c = s.counts || s.reactions || { green: 0, yellow: 0, red: 0 }
  const green = c.green || 0
  const yellow = c.yellow || 0
  const red = c.red || 0
  const explicitNone = typeof c.none === 'number' ? c.none : null
  const total = s.studentCount || 0
  const none = explicitNone !== null ? explicitNone : Math.max(0, total - green - yellow - red)
  return { green, yellow, red, none }
}

// ───────────────────────────────────────────────────────────────────────
export function SessionFlowChart({ data }: { data: Snapshot[] }) {
  const series = useMemo(() => data.map(d => ({ t: d.t, ...decompose(d) })), [data])

  const peakStudent = useMemo(
    () => Math.max(0, ...series.map(s => s.green + s.yellow + s.red + s.none)),
    [series]
  )
  const peakResponded = useMemo(
    () => Math.max(0, ...series.map(s => s.green + s.yellow + s.red)),
    [series]
  )
  const peakStuck = useMemo(() => Math.max(0, ...series.map(s => s.yellow + s.red)), [series])
  const peakRed = useMemo(() => Math.max(0, ...series.map(s => s.red)), [series])

  if (series.length < 2) return <ChartEmpty />

  // y축 — 응답 max에 약간 여유(20%) 더해서 천장 닿지 않게.
  const yMax = Math.max(2, Math.ceil(peakResponded * 1.2))

  const tMin = series[0].t
  const tMax = series[series.length - 1].t
  const xRange = tMax - tMin || 1
  const xOf = (t: number) => PAD_X + ((t - tMin) / xRange) * (VBOX_W - 2 * PAD_X)
  const yOf = (v: number) => VBOX_H - PAD_BOTTOM - (v / yMax) * (VBOX_H - PAD_TOP - PAD_BOTTOM)

  function stepArea(getStackTop: (s: typeof series[number]) => number) {
    const cmds: string[] = []
    const baseline = VBOX_H - PAD_BOTTOM
    const x0 = xOf(series[0].t)
    cmds.push(`M ${x0},${baseline}`, `L ${x0},${yOf(getStackTop(series[0]))}`)
    for (let i = 1; i < series.length; i++) {
      const xi = xOf(series[i].t)
      cmds.push(`H ${xi}`, `V ${yOf(getStackTop(series[i]))}`)
    }
    cmds.push(`L ${xOf(series[series.length - 1].t)},${baseline} Z`)
    return cmds.join(' ')
  }

  function stepLine(getStackTop: (s: typeof series[number]) => number) {
    const cmds: string[] = []
    const x0 = xOf(series[0].t)
    cmds.push(`M ${x0},${yOf(getStackTop(series[0]))}`)
    for (let i = 1; i < series.length; i++) {
      const xi = xOf(series[i].t)
      cmds.push(`H ${xi}`, `V ${yOf(getStackTop(series[i]))}`)
    }
    return cmds.join(' ')
  }

  const greenStack = (s: typeof series[number]) => s.green
  const yellowStack = (s: typeof series[number]) => s.green + s.yellow
  const redStack = (s: typeof series[number]) => s.green + s.yellow + s.red

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-x-4 gap-y-1">
        <div className="text-white/80 text-sm font-semibold tracking-tight">수업 흐름</div>
        <div className="text-white/50 text-xs space-x-3 tabular-nums">
          <span>최대 <span className="text-white font-semibold">{peakStudent}</span>명</span>
          {peakStuck > 0 && (
            <span>
              막힘 <span className="text-rose-400 font-semibold">{peakStuck}</span>명
              {peakRed > 0 && <span className="text-rose-400/60"> (🔴 {peakRed})</span>}
            </span>
          )}
        </div>
      </div>

      <div className="bg-white/[0.02] rounded-xl overflow-hidden ring-1 ring-white/[0.06]">
        <svg viewBox={`0 0 ${VBOX_W} ${VBOX_H}`} className="block w-full" preserveAspectRatio="none" style={{ height: 144 }}>
          {/* baseline */}
          <line x1={0} x2={VBOX_W} y1={VBOX_H - PAD_BOTTOM} y2={VBOX_H - PAD_BOTTOM}
                stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />

          {/* 가로 보조선 — 25/50/75% */}
          {[0.25, 0.5, 0.75].map(p => (
            <line key={p}
                  x1={0} x2={VBOX_W}
                  y1={yOf(yMax * p)} y2={yOf(yMax * p)}
                  stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" strokeDasharray="2 4" />
          ))}

          {/* stacked — 빨강(top) → 노랑 → 초록(bottom). 단색 + opacity. */}
          <path d={stepArea(redStack)} fill="rgba(244,63,94,0.7)" />
          <path d={stepArea(yellowStack)} fill="rgba(251,191,36,0.78)" />
          <path d={stepArea(greenStack)} fill="rgba(16,185,129,0.78)" />

          {/* 각 영역 윗 경계 stroke — 얇고 또렷이 */}
          <path d={stepLine(redStack)} fill="none" stroke="#fb7185" strokeOpacity="0.95" strokeWidth="1.25" strokeLinejoin="miter" />
          <path d={stepLine(yellowStack)} fill="none" stroke="#fbbf24" strokeOpacity="0.95" strokeWidth="1.25" strokeLinejoin="miter" />
          <path d={stepLine(greenStack)} fill="none" stroke="#34d399" strokeOpacity="0.95" strokeWidth="1.25" strokeLinejoin="miter" />
        </svg>
        <TimeAxis first={tMin} last={tMax} />
      </div>

      <div className="flex items-center gap-4 mt-3 text-sm flex-wrap">
        <LegendDot color="bg-emerald-500" label="이해 완료" />
        <LegendDot color="bg-amber-400" label="속도 조절" />
        <LegendDot color="bg-rose-500" label="재설명" />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// 옛 import 호환
export const StudentCountChart = SessionFlowChart
export const ReactionTimelineChart = SessionFlowChart

// ───────────────────────────────────────────────────────────────────────
function TimeAxis({ first, last }: { first: number; last: number }) {
  return (
    <div className="flex justify-between px-3 py-1.5 text-white/35 text-xs font-mono border-t border-white/[0.04]">
      <span>{formatTime(first)}</span>
      <span>{formatTime(last)}</span>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-white/60 text-xs">{label}</span>
    </div>
  )
}

function ChartEmpty() {
  return (
    <div className="bg-white/[0.02] ring-1 ring-white/[0.06] rounded-xl py-10 text-center text-white/35 text-sm">
      데이터가 부족합니다
    </div>
  )
}
