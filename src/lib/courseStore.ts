// 교수자 머신에 저장되는 강의 목록 — localStorage + (있으면) Electron userData 백업.
// 학기 내내 ownerToken이 살아있어야 같은 course에 재진입 가능.

export type StoredCourse = {
  courseId: string
  ownerToken: string
  name: string | null
  createdAt: number
  lastUsedAt: number
}

const KEY = 'cb-courses'

declare global {
  interface Window {
    electronAPI?: {
      openWidget: (roomId: string, ownerToken?: string) => void
      closeWidget: () => void
      toggleCompact: (compact: boolean) => void
      setLiveSize: (payload: { mode: 'review' } | { mode: 'live'; contentHeight: number }) => void
      openExternal: (url: string) => void
      onFlushSession?: (cb: (data: { kind: string }) => void) => () => void
      flushSessionDone?: () => void
      readCoursesBackup?: () => Promise<StoredCourse[] | null>
      writeCoursesBackup?: (data: StoredCourse[]) => Promise<boolean>
      isElectron: boolean
    }
  }
}

function readLocal(): StoredCourse[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(isValid) : []
  } catch { return [] }
}

function writeLocal(courses: StoredCourse[]) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(KEY, JSON.stringify(courses)) } catch {}
}

function isValid(c: unknown): c is StoredCourse {
  return !!c && typeof c === 'object'
    && typeof (c as StoredCourse).courseId === 'string'
    && typeof (c as StoredCourse).ownerToken === 'string'
}

// 첫 로드 시 — localStorage가 비었고 Electron 파일 백업이 있으면 그걸로 복구
let bootstrapped = false
async function bootstrap(): Promise<StoredCourse[]> {
  if (typeof window === 'undefined') return []
  const local = readLocal()
  if (local.length > 0 || bootstrapped) { bootstrapped = true; return local }
  bootstrapped = true
  const api = window.electronAPI
  if (api?.readCoursesBackup) {
    try {
      const file = await api.readCoursesBackup()
      if (Array.isArray(file) && file.length > 0) {
        const valid = file.filter(isValid)
        writeLocal(valid)
        return valid
      }
    } catch {}
  }
  return []
}

async function persist(courses: StoredCourse[]) {
  writeLocal(courses)
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (api?.writeCoursesBackup) {
    try { await api.writeCoursesBackup(courses) } catch {}
  }
}

export async function loadCourses(): Promise<StoredCourse[]> {
  const arr = await bootstrap()
  // 최신 사용 순으로
  return [...arr].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export async function upsertCourse(c: StoredCourse): Promise<StoredCourse[]> {
  const cur = readLocal()
  const idx = cur.findIndex(x => x.courseId === c.courseId)
  if (idx >= 0) cur[idx] = { ...cur[idx], ...c }
  else cur.unshift(c)
  await persist(cur)
  return cur
}

export async function removeCourse(courseId: string): Promise<StoredCourse[]> {
  const cur = readLocal().filter(x => x.courseId !== courseId)
  await persist(cur)
  return cur
}

export async function touchCourse(courseId: string): Promise<void> {
  const cur = readLocal()
  const idx = cur.findIndex(x => x.courseId === courseId)
  if (idx < 0) return
  cur[idx].lastUsedAt = Date.now()
  await persist(cur)
}

export async function renameCourse(courseId: string, name: string | null): Promise<void> {
  const cur = readLocal()
  const idx = cur.findIndex(x => x.courseId === courseId)
  if (idx < 0) return
  cur[idx].name = name && name.trim() ? name.trim() : null
  await persist(cur)
}

// 화면용: 마지막 사용 상대 시간 — 한국어 짧은 표기
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '방금'
  if (diff < hour) return `${Math.floor(diff / min)}분 전`
  if (diff < day) return `${Math.floor(diff / hour)}시간 전`
  if (diff < 7 * day) return `${Math.floor(diff / day)}일 전`
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}주 전`
  return `${Math.floor(diff / (30 * day))}달 전`
}
