import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { QRCodeSVG } from 'qrcode.react'
import { getSocket } from '@/lib/socket'
import {
  StoredCourse,
  loadCourses,
  upsertCourse,
  removeCourse,
  touchCourse,
  renameCourse,
  relativeTime,
} from '@/lib/courseStore'

type View = 'list' | 'create' | 'qr'

export default function Home() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [isElectron, setIsElectron] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [studentCode, setStudentCode] = useState('')

  // Electron-only
  const [courses, setCourses] = useState<StoredCourse[]>([])
  const [view, setView] = useState<View>('list')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [shareCourse, setShareCourse] = useState<StoredCourse | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setMounted(true)
    const electron = !!window.electronAPI
    setIsElectron(electron)
    setBaseUrl(window.location.origin)
    if (electron) {
      loadCourses().then(setCourses).catch(() => setCourses([]))
    }
  }, [])

  // 메뉴 외부 클릭 닫기
  useEffect(() => {
    if (!menuOpenFor) return
    const close = () => setMenuOpenFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpenFor])

  // rename 시작 시 input 포커스
  useEffect(() => {
    if (renamingId && renameInputRef.current) renameInputRef.current.focus()
  }, [renamingId])

  const refreshList = useCallback(async () => {
    const list = await loadCourses()
    setCourses(list)
  }, [])

  const createCourse = useCallback((name: string | null) => {
    setCreating(true)
    setCreateError(null)
    const socket = getSocket()
    const doCreate = () => {
      socket.emit('create-room', async (res: { roomId?: string; ownerToken?: string; error?: string }) => {
        if (res?.error) { setCreateError(res.error); setCreating(false); return }
        if (res?.roomId && res?.ownerToken) {
          const cleanedName = name && name.trim() ? name.trim().substring(0, 60) : null
          const now = Date.now()
          const c: StoredCourse = {
            courseId: res.roomId,
            ownerToken: res.ownerToken,
            name: cleanedName,
            createdAt: now,
            lastUsedAt: now,
          }
          await upsertCourse(c)
          if (cleanedName) {
            try {
              socket.emit('course-rename', {
                courseId: c.courseId,
                ownerToken: c.ownerToken,
                name: cleanedName,
              })
            } catch {}
          }
          await refreshList()
          setShareCourse(c)
          setPendingName('')
          setView('qr')
        }
        setCreating(false)
      })
    }
    if (socket.connected) doCreate()
    else { socket.once('connect', doCreate); socket.connect() }
  }, [refreshList])

  const openCourse = useCallback(async (c: StoredCourse) => {
    await touchCourse(c.courseId)
    refreshList()
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.openWidget(c.courseId, c.ownerToken)
    } else {
      router.push(`/p/${c.courseId}#t=${encodeURIComponent(c.ownerToken)}`)
    }
  }, [refreshList, router])

  const submitRename = async (c: StoredCourse) => {
    const next = renameDraft.trim().substring(0, 60) || null
    await renameCourse(c.courseId, next)
    setRenamingId(null)
    setRenameDraft('')
    refreshList()
    // 서버 동기화 (실패는 무시 — 로컬은 이미 변경됨)
    try {
      const socket = getSocket()
      const sync = () => socket.emit('course-rename', {
        courseId: c.courseId, ownerToken: c.ownerToken, name: next,
      })
      if (socket.connected) sync()
      else { socket.once('connect', sync); socket.connect() }
    } catch {}
  }

  const handleRemove = async (c: StoredCourse) => {
    const ok = window.confirm(
      `"${c.name || c.courseId}" 강의를 이 컴퓨터의 목록에서 제거할까요?\n\n` +
      `학생이 이미 받은 링크는 서버에 1년간 살아있지만, 이 컴퓨터에서는 다시 들어갈 수 없게 됩니다.`
    )
    if (!ok) return
    await removeCourse(c.courseId)
    refreshList()
  }

  const studentUrlFor = (c: StoredCourse) => baseUrl ? `${baseUrl}/s/${c.courseId}` : ''

  const copyLink = (url: string) => {
    if (!url) return
    navigator.clipboard.writeText(url)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1800)
  }

  if (!mounted) return null

  // ── 비 Electron: 학생용 화면 ──────────────────────────────────────────────
  if (!isElectron) {
    const goToRoom = () => {
      const code = studentCode.trim().toUpperCase()
      if (code.length >= 4) router.push(`/s/${code}`)
    }
    return (
      <>
        <Head>
          <title>ClassBridge</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-sm space-y-8 text-center">
            <div>
              <h1 className="text-3xl font-bold text-white tracking-tight">ClassBridge</h1>
              <p className="text-white/60 text-sm mt-2">실시간 익명 수업 소통 도구</p>
            </div>
            <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-6 space-y-4 text-left">
              <p className="text-white/70 text-base leading-relaxed">교수님이 공유한 QR 코드를 스캔하거나,<br/>강의 코드를 입력하세요.</p>
              <input
                type="text"
                value={studentCode}
                onChange={e => setStudentCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && goToRoom()}
                placeholder="예: AB3F7K"
                maxLength={8}
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder-white/40 text-base font-mono tracking-widest focus:outline-none focus:border-white/40"
              />
              <button
                onClick={goToRoom}
                disabled={studentCode.trim().length < 4}
                className="w-full py-3.5 rounded-xl text-base font-semibold bg-white text-black hover:bg-white/90 active:bg-white/80 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                접속하기
              </button>
            </div>
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

  // ── Electron: 교수자 화면 (강의 목록) ────────────────────────────────────
  return (
    <>
      <Head>
        <title>ClassBridge</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
        <div className="w-full max-w-md mx-auto px-6 py-10 flex-1">

          {/* 헤더 */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white tracking-tight">ClassBridge</h1>
            <p className="text-white/60 text-sm mt-1.5">실시간 익명 수업 소통 도구</p>
          </div>

          {/* 강의 목록 */}
          {courses.length === 0 ? (
            <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-8 text-center space-y-5">
              <p className="text-white/70 text-base leading-relaxed">
                아직 만든 강의가 없습니다.<br/>
                강의를 만들면 학기 내내 같은 링크로<br/>학생들과 만날 수 있습니다.
              </p>
              <button
                onClick={() => setView('create')}
                className="w-full py-3.5 rounded-xl text-base font-semibold bg-white text-black hover:bg-white/90 active:bg-white/80 transition-all"
              >
                + 첫 강의 만들기
              </button>
            </div>
          ) : (
            <>
              <div className="text-white/60 text-sm uppercase tracking-widest mb-3 px-1 font-medium">
                내 강의
              </div>
              <div className="space-y-2 mb-3">
                {courses.map((c) => {
                  const isRenaming = renamingId === c.courseId
                  return (
                    <div
                      key={c.courseId}
                      className="group relative bg-white/[0.04] border border-white/10 hover:border-white/20 rounded-xl px-4 py-3.5 transition-all"
                    >
                      <div className="flex items-center gap-3">
                        {/* 좌측: 이름/코드 */}
                        <button
                          onClick={() => !isRenaming && openCourse(c)}
                          className="flex-1 text-left min-w-0"
                          disabled={isRenaming}
                        >
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value.slice(0, 60))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') submitRename(c)
                                if (e.key === 'Escape') { setRenamingId(null); setRenameDraft('') }
                              }}
                              onBlur={() => submitRename(c)}
                              placeholder="강의 이름"
                              className="w-full bg-white/5 border border-white/20 rounded-md px-2 py-1.5 text-white text-base focus:outline-none focus:border-white/40"
                            />
                          ) : (
                            <>
                              <div className="text-white text-base font-semibold truncate">
                                {c.name || <span className="text-white/50 font-normal">이름 없음</span>}
                              </div>
                              <div className="text-white/50 text-sm font-mono mt-1">
                                #{c.courseId} · {relativeTime(c.lastUsedAt)}
                              </div>
                            </>
                          )}
                        </button>

                        {/* 우측: 메뉴 */}
                        {!isRenaming && (
                          <div className="relative" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setMenuOpenFor(menuOpenFor === c.courseId ? null : c.courseId)}
                              className="text-white/30 hover:text-white/70 px-2 py-1 rounded transition-colors"
                              aria-label="메뉴"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="5" cy="12" r="2"/>
                                <circle cx="12" cy="12" r="2"/>
                                <circle cx="19" cy="12" r="2"/>
                              </svg>
                            </button>
                            {menuOpenFor === c.courseId && (
                              <div className="absolute right-0 top-full mt-1 w-44 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl py-1 z-20">
                                <button
                                  onClick={() => {
                                    setMenuOpenFor(null)
                                    setRenamingId(c.courseId)
                                    setRenameDraft(c.name || '')
                                  }}
                                  className="w-full text-left px-3 py-2 text-sm text-white/80 hover:bg-white/5"
                                >
                                  이름 편집
                                </button>
                                <button
                                  onClick={() => { setMenuOpenFor(null); setShareCourse(c) }}
                                  className="w-full text-left px-3 py-2 text-sm text-white/80 hover:bg-white/5"
                                >
                                  학생 링크/QR 보기
                                </button>
                                <div className="border-t border-white/10 my-1" />
                                <button
                                  onClick={() => { setMenuOpenFor(null); handleRemove(c) }}
                                  className="w-full text-left px-3 py-2 text-sm text-rose-400 hover:bg-rose-500/10"
                                >
                                  목록에서 제거
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <button
                onClick={() => setView('create')}
                className="w-full py-2.5 rounded-xl text-sm font-medium border border-dashed border-white/15 text-white/50 hover:border-white/30 hover:text-white/80 transition-all"
              >
                + 새 강의 만들기
              </button>
            </>
          )}
        </div>

        {/* 푸터 */}
        <div className="text-center pb-6 text-white/15 text-xs">
          ClassBridge
        </div>
      </div>

      {/* 강의 만들기 모달 */}
      {view === 'create' && (
        <Modal onClose={() => { if (!creating) { setView('list'); setPendingName(''); setCreateError(null) } }}>
          <h2 className="text-white text-xl font-semibold mb-2">새 강의 만들기</h2>
          <p className="text-white/60 text-sm mb-6 leading-relaxed">
            강의 이름은 비워둬도 됩니다. 나중에 언제든 바꿀 수 있어요.
          </p>
          <input
            type="text"
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value.slice(0, 60))}
            onKeyDown={(e) => { if (e.key === 'Enter' && !creating) createCourse(pendingName) }}
            placeholder="예: 선형대수 화3"
            disabled={creating}
            autoFocus
            maxLength={60}
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder-white/40 text-base focus:outline-none focus:border-white/40 mb-4"
          />
          <button
            onClick={() => createCourse(pendingName)}
            disabled={creating}
            className="w-full py-3.5 rounded-xl text-base font-semibold bg-white text-black hover:bg-white/90 active:bg-white/80 transition-all disabled:opacity-50"
          >
            {creating ? '만드는 중...' : '강의 만들기'}
          </button>
          {createError && (
            <p className="text-rose-400 text-sm text-center mt-3">
              {createError === 'rate_limited'
                ? '잠시 후 다시 시도해 주세요.'
                : '강의 생성에 실패했습니다.'}
            </p>
          )}
          <button
            onClick={() => { if (!creating) { setView('list'); setPendingName(''); setCreateError(null) } }}
            disabled={creating}
            className="w-full mt-3 text-white/60 text-sm hover:text-white transition-colors py-1.5"
          >
            취소
          </button>
        </Modal>
      )}

      {/* QR/링크 모달 */}
      {shareCourse && (() => {
        const url = studentUrlFor(shareCourse)
        return (
          <Modal onClose={() => setShareCourse(null)}>
            <div className="text-center mb-4">
              <h2 className="text-white text-xl font-semibold">
                {shareCourse.name || '강의'}
              </h2>
              <p className="text-white/60 text-sm font-mono mt-1">#{shareCourse.courseId}</p>
            </div>
            <div className="bg-white rounded-xl p-5 flex flex-col items-center gap-3 mb-4">
              {url && (
                <QRCodeSVG value={url} size={180} bgColor="#ffffff" fgColor="#0a0a0a" level="M" />
              )}
              <p className="text-black/60 text-sm">학생이 이 QR을 스캔하면 바로 접속됩니다</p>
            </div>
            <div className="bg-white/5 border border-white/15 rounded-xl p-3 flex items-center gap-2 mb-3">
              <code className="flex-1 text-white text-sm font-mono truncate">{url}</code>
              <button
                onClick={() => copyLink(url)}
                className="text-white/70 hover:text-white text-sm px-3 py-1.5 border border-white/15 rounded-lg hover:border-white/30 transition-all whitespace-nowrap"
              >
                {linkCopied ? '✓ 복사됨' : '복사'}
              </button>
            </div>
            <button
              onClick={() => { const c = shareCourse; setShareCourse(null); openCourse(c) }}
              className="w-full py-3.5 rounded-xl text-base font-semibold bg-white text-black hover:bg-white/90 active:bg-white/80 transition-all"
            >
              대시보드 열기 →
            </button>
            <button
              onClick={() => setShareCourse(null)}
              className="w-full mt-2 text-white/60 text-sm hover:text-white transition-colors py-2"
            >
              닫기
            </button>
          </Modal>
        )
      })()}
    </>
  )
}

// ── 단순한 모달 ───────────────────────────────────────────────────────────
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-[#0d0d0d] border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
