const { createServer } = require('http')
const { parse } = require('url')
const crypto = require('crypto')
const next = require('next')
const { Server } = require('socket.io')
const { createClient } = require('redis')
const { createAdapter } = require('@socket.io/redis-adapter')

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || 'localhost'
const port = parseInt(process.env.PORT || '3000', 10)
const REDIS_URL = process.env.REDIS_URL
const COURSE_TTL = 60 * 60 * 24 * 365     // 1년
const GRACE_MS = 60 * 60 * 1000           // 교수자 disconnect grace 1시간
const ARCHIVE_LIMIT = 30
const MAX_STUDENTS_PER_SESSION = 500          // 한 회차 최대 동시 학생 수
const ARCHIVED_QUESTION_PRUNE_MS = 30 * 24 * 60 * 60 * 1000  // 30일 후 본문 prune
// timeline은 변화 시점(reaction/join/leave)에만 push. 50ms 이내 변화는 덮어쓰기로 압축.
const TIMELINE_COMPRESS_MS = 50
const TIMELINE_MAX = 1000

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// IP당 동시 socket 한도 — DoS 방어. Fly.io는 x-forwarded-for로 실제 IP 전달.
const MAX_CONN_PER_IP = 50
const ipConnCount = new Map()
function ipFromSocket(socket) {
  const xff = socket.handshake.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  return socket.handshake.address || 'unknown'
}

// ─── 로그 ─────────────────────────────────────────────────────────────────
function log(level, event, data = {}) {
  try {
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...data }) + '\n')
  } catch {}
}

// ─── 검증 ─────────────────────────────────────────────────────────────────
const COURSE_ID_RE = /^[A-Z2-9]{6,8}$/
const validCourseId = id => typeof id === 'string' && COURSE_ID_RE.test(id)
const validToken = t => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t)
// 학생 디바이스 ID — uuid v4 또는 16~64자 영숫자/하이픈
const validStudentId = id => typeof id === 'string' && /^[a-f0-9-]{16,64}$/i.test(id)

// ─── Course/Session 헬퍼 ──────────────────────────────────────────────────
function freshCourse(ownerToken) {
  return {
    schemaV: 3,
    ownerToken,
    name: null,
    createdAt: Date.now(),
    currentSession: null,
    archivedSessions: [],
  }
}

function freshSession() {
  const now = Date.now()
  return {
    id: crypto.randomBytes(4).toString('hex'),
    startedAt: now,
    lastSeen: now,
    endedAt: null,
    // 학생 디바이스별 현재 상태 — 누적 카운터 X, 실시간 분포만.
    // students[studentId] = { state, sockets[], joinedAt, lastReactionAt }
    students: {},
    questions: [],
    peakStudentCount: 0,
    timeline: [{ t: now, counts: { green: 0, yellow: 0, red: 0, none: 0 }, studentCount: 0 }],
  }
}

function countStates(students) {
  const c = { green: 0, yellow: 0, red: 0, none: 0 }
  if (!students) return c
  for (const id in students) {
    const st = students[id].state
    if (st === 'green' || st === 'yellow' || st === 'red') c[st]++
    else c.none++
  }
  return c
}
const studentCountOf = students => students ? Object.keys(students).length : 0

// 변화 시점 push. 직전 점이 압축 윈도우 안이면 그 점을 덮어쓰기(데이터 폭주 방지).
function recordChange(session, now = Date.now()) {
  if (!session.timeline) session.timeline = []
  const last = session.timeline[session.timeline.length - 1]
  const counts = countStates(session.students)
  const sCount = studentCountOf(session.students)
  if (last && now - last.t < TIMELINE_COMPRESS_MS) {
    last.t = now
    last.counts = counts
    last.studentCount = sCount
    return
  }
  session.timeline.push({ t: now, counts, studentCount: sCount })
  if (session.timeline.length > TIMELINE_MAX) {
    session.timeline = session.timeline.slice(-TIMELINE_MAX)
  }
}

// 종료 시점 — 압축 윈도우 무시하고 무조건 마지막 점 박음.
function forceSnapshot(session, now = Date.now()) {
  if (!session.timeline) session.timeline = []
  session.timeline.push({
    t: now,
    counts: countStates(session.students),
    studentCount: studentCountOf(session.students),
  })
  if (session.timeline.length > TIMELINE_MAX) session.timeline = session.timeline.slice(-TIMELINE_MAX)
}

function summarizeSession(s) {
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    finalCounts: countStates(s.students),
    questionCount: s.questions.length,
    questions: s.questions,
    peakStudentCount: s.peakStudentCount,
    timeline: s.timeline || [],
  }
}

function archiveIfExpired(course, now = Date.now()) {
  const s = course.currentSession
  if (!s || s.endedAt) return { expired: false, archivedSession: null }
  if (now - s.lastSeen <= GRACE_MS) return { expired: false, archivedSession: null }
  s.endedAt = s.lastSeen
  forceSnapshot(s, s.lastSeen)
  const summary = summarizeSession(s)
  course.archivedSessions = course.archivedSessions || []
  course.archivedSessions.push(summary)
  if (course.archivedSessions.length > ARCHIVE_LIMIT) {
    course.archivedSessions = course.archivedSessions.slice(-ARCHIVE_LIMIT)
  }
  course.currentSession = null
  return { expired: true, archivedSession: summary }
}

function isSessionLive(course) {
  const s = course.currentSession
  return !!(s && !s.endedAt && (Date.now() - s.lastSeen <= GRACE_MS))
}

// 30일 지난 archived 회차의 질문 본문 제거 (count + 그래프는 유지).
// 부수효과로 course가 변경되면 true 반환 — 호출자가 save 결정.
function pruneOldArchives(course, now = Date.now()) {
  if (!course?.archivedSessions?.length) return false
  let changed = false
  const cutoff = now - ARCHIVED_QUESTION_PRUNE_MS
  for (const s of course.archivedSessions) {
    if (s.endedAt && s.endedAt < cutoff && s.questions && s.questions.length > 0) {
      s.questions = []
      s.questionsPruned = true
      changed = true
    }
  }
  return changed
}

function generateCourseId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = ''
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}
const generateQuestionId = () => crypto.randomBytes(4).toString('hex')
const generateOwnerToken = () => crypto.randomBytes(16).toString('hex')

// ─── Course별 직렬화 (mutex) ────────────────────────────────────────────
// GET → modify → SET 사이 race로 데이터 손실 방지. 같은 courseId 처리만 직렬화.
// 단일 머신 한정. 멀티 인스턴스는 Redis WATCH/MULTI 또는 Lua가 정답이지만
// 베타는 단일 인스턴스 운영이라 in-memory mutex로 충분.
const courseLocks = new Map()
async function withCourseLock(courseId, fn) {
  const prev = courseLocks.get(courseId) || Promise.resolve()
  const next = prev.then(fn, fn)  // 이전이 실패해도 다음 작업은 진행
  // 마지막 promise만 Map에 보관 — 이전 promise는 reference 끊어져 GC 가능
  courseLocks.set(courseId, next.catch(() => undefined))
  return next
}

// ─── Rate limit ──────────────────────────────────────────────────────────
function rateLimit(socket, key, minIntervalMs) {
  if (!socket.data.rl) socket.data.rl = {}
  const now = Date.now()
  const last = socket.data.rl[key] || 0
  if (now - last < minIntervalMs) return false
  socket.data.rl[key] = now
  return true
}

// ─── 부트 ────────────────────────────────────────────────────────────────
app.prepare().then(async () => {
  const httpServer = createServer((req, res) => handle(req, res, parse(req.url, true)))

  // CORS — production에선 CORS_ORIGIN 명시 필수. 미설정 시 cross-origin 모두 거부.
  let corsOrigins
  if (process.env.CORS_ORIGIN) {
    corsOrigins = process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  } else if (dev) {
    corsOrigins = '*'
  } else {
    log('warn', 'cors_origin_unset_in_production', {})
    corsOrigins = false  // socket.io: cross-origin 거부
  }
  const io = new Server(httpServer, { cors: { origin: corsOrigins, methods: ['GET', 'POST'] } })

  let redis = null
  if (REDIS_URL) {
    try {
      const pubClient = createClient({ url: REDIS_URL })
      const subClient = pubClient.duplicate()
      pubClient.on('error', e => log('error', 'redis_pub_error', { msg: e.message }))
      subClient.on('error', e => log('error', 'redis_sub_error', { msg: e.message }))
      await Promise.all([pubClient.connect(), subClient.connect()])
      io.adapter(createAdapter(pubClient, subClient))
      redis = pubClient
      log('info', 'redis_connected')
    } catch (e) {
      log('warn', 'redis_connect_failed', { msg: e.message })
    }
  } else {
    log('info', 'memory_mode')
  }

  const memCourses = new Map()
  const courseStore = {
    async get(courseId) {
      if (redis) {
        const raw = await redis.get(`course:${courseId}`)
        if (!raw) return null
        try { return JSON.parse(raw) } catch { return null }
      }
      return memCourses.get(courseId) || null
    },
    async save(courseId, data) {
      if (redis) await redis.setEx(`course:${courseId}`, COURSE_TTL, JSON.stringify(data))
      else memCourses.set(courseId, data)
    },
    async exists(courseId) {
      if (redis) return (await redis.exists(`course:${courseId}`)) === 1
      return memCourses.has(courseId)
    },
  }

  // ─── 소켓 ─────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    // IP당 connection 한도 — 한 IP가 너무 많은 socket을 열면 거부
    const ip = ipFromSocket(socket)
    const cur = (ipConnCount.get(ip) || 0) + 1
    if (cur > MAX_CONN_PER_IP) {
      log('warn', 'ip_conn_limit', { ip, count: cur })
      socket.disconnect(true)
      return
    }
    ipConnCount.set(ip, cur)
    socket.data.ip = ip

    log('info', 'socket_connect', { sid: socket.id, ip })

    // 강의 생성 (교수자) — create-course / create-room 둘 다 매핑
    const handleCreate = async (callback) => {
      if (!rateLimit(socket, 'create', 10_000)) {
        log('warn', 'rate_limited', { sid: socket.id, event: 'create-course' })
        if (typeof callback === 'function') callback({ error: 'rate_limited' })
        return
      }
      let courseId, attempts = 0
      do {
        courseId = generateCourseId()
        if (++attempts > 10) {
          log('error', 'id_collision_exhausted', { sid: socket.id })
          if (typeof callback === 'function') callback({ error: 'collision' })
          return
        }
      } while (await courseStore.exists(courseId))

      const ownerToken = generateOwnerToken()
      const course = freshCourse(ownerToken)
      await courseStore.save(courseId, course)
      socket.data.profOf = courseId
      log('info', 'course_created', { sid: socket.id, courseId })
      if (typeof callback === 'function') callback({ roomId: courseId, courseId, ownerToken })
    }
    socket.on('create-course', handleCreate)
    socket.on('create-room', handleCreate)

    // 입장
    const handleJoin = async (payload) => {
      if (!rateLimit(socket, 'join', 1000)) return

      const courseId = payload?.courseId || payload?.roomId
      const role = payload?.role
      const ownerToken = payload?.ownerToken
      const studentId = payload?.studentId

      if (!validCourseId(courseId)) {
        socket.emit('join-error', { reason: 'invalid_room_id' })
        return
      }
      if (role !== 'student' && role !== 'professor') {
        socket.emit('join-error', { reason: 'invalid_role' })
        return
      }
      if (role === 'student' && !validStudentId(studentId)) {
        socket.emit('join-error', { reason: 'invalid_student_id' })
        return
      }

      // ─── 이전 강의에서 빠지기 (이전 강의 lock 안) ───
      if (socket.data.currentCourseId && socket.data.currentCourseId !== courseId) {
        const prevId = socket.data.currentCourseId
        const prevSid = socket.data.studentId
        socket.leave(prevId)
        if (socket.data.currentRole === 'student' && prevSid) {
          let prevCounts = null, prevCount = 0
          await withCourseLock(prevId, async () => {
            const prev = await courseStore.get(prevId)
            if (prev?.currentSession?.students?.[prevSid]) {
              const stu = prev.currentSession.students[prevSid]
              stu.sockets = stu.sockets.filter(x => x !== socket.id)
              if (stu.sockets.length === 0) delete prev.currentSession.students[prevSid]
              await courseStore.save(prevId, prev)
              prevCounts = countStates(prev.currentSession.students)
              prevCount = studentCountOf(prev.currentSession.students)
            }
          })
          if (prevCounts) {
            io.to(prevId).emit('reaction-update', { reactions: prevCounts })
            io.to(prevId).emit('student-count', prevCount)
          }
        }
      }

      // ─── 현재 강의 join (현재 강의 lock 안) ───
      let result = null
      await withCourseLock(courseId, async () => {
        const course = await courseStore.get(courseId)
        if (!course) {
          result = { kind: 'error', reason: 'room_not_found' }
          log('warn', 'join_not_found', { sid: socket.id, courseId, role })
          return
        }

        if (role === 'professor') {
          if (!validToken(ownerToken) || ownerToken !== course.ownerToken) {
            result = { kind: 'error', reason: 'unauthorized' }
            log('warn', 'join_unauthorized', { sid: socket.id, courseId })
            return
          }
          socket.data.profOf = courseId
        }

        const { expired, archivedSession } = archiveIfExpired(course)
        const pruned = pruneOldArchives(course)
        let needSave = expired || pruned

        if (role === 'professor') {
          const live = isSessionLive(course)
          if (live) {
            course.currentSession.lastSeen = Date.now()
            needSave = true
          }
          if (needSave) await courseStore.save(courseId, course)
          const s = live ? course.currentSession : null
          result = {
            kind: 'professor',
            expired, archivedSession,
            roomState: {
              courseId,
              name: course.name,
              isLive: live,
              sessionId: s ? s.id : null,
              reactions: s ? countStates(s.students) : { green: 0, yellow: 0, red: 0, none: 0 },
              questions: s ? s.questions.filter(q => !q.dismissed) : [],
              studentCount: s ? studentCountOf(s.students) : 0,
              archivedSessions: course.archivedSessions || [],
            },
            live, sessionId: s?.id,
          }
        } else {
          // 학생
          if (isSessionLive(course)) {
            const s = course.currentSession
            if (!s.students) s.students = {}
            const isExisting = !!s.students[studentId]
            const curCount = studentCountOf(s.students)
            // 학생 수 한도 — 신규 학생만 차단. 기존 학생의 추가 socket은 허용.
            if (!isExisting && curCount >= MAX_STUDENTS_PER_SESSION) {
              if (needSave) await courseStore.save(courseId, course)
              result = { kind: 'session-full', expired, archivedSession }
              log('warn', 'session_full', { sid: socket.id, courseId, max: MAX_STUDENTS_PER_SESSION })
              return
            }
            let stu = s.students[studentId]
            if (!stu) {
              stu = { state: null, sockets: [socket.id], joinedAt: Date.now(), lastReactionAt: 0 }
              s.students[studentId] = stu
            } else if (!stu.sockets.includes(socket.id)) {
              stu.sockets.push(socket.id)
            }
            const newCount = studentCountOf(s.students)
            if (newCount > (s.peakStudentCount || 0)) s.peakStudentCount = newCount
            recordChange(s)
            await courseStore.save(courseId, course)
            result = {
              kind: 'student-joined',
              expired, archivedSession,
              counts: countStates(s.students),
              count: newCount,
              roomJoined: {
                ok: true,
                sessionId: s.id,
                startedAt: s.startedAt,
                myState: stu.state,
                reactions: countStates(s.students),
                name: course.name,
              },
            }
          } else {
            if (needSave) await courseStore.save(courseId, course)
            result = {
              kind: 'student-waiting',
              expired, archivedSession,
              waiting: { courseId, name: course.name },
            }
          }
        }
      })

      if (!result) return

      // ─── lock 밖에서 socket 메타 + emit ───
      if (result.kind === 'error') {
        socket.emit('join-error', { reason: result.reason })
        return
      }
      if (result.kind === 'session-full') {
        socket.emit('join-error', { reason: 'session_full' })
        return
      }

      socket.data.currentCourseId = courseId
      socket.data.currentRole = role
      socket.data.studentId = role === 'student' ? studentId : null
      socket.join(courseId)

      if (result.expired && result.archivedSession) {
        io.to(courseId).emit('session-ended', { sessionId: result.archivedSession.id })
        log('info', 'session_archived', { courseId, sessionId: result.archivedSession.id })
      }

      if (result.kind === 'professor') {
        socket.emit('room-state', result.roomState)
        log('info', result.live ? 'session_resumed' : 'professor_review_mode',
          { courseId, sessionId: result.sessionId })
      } else if (result.kind === 'student-joined') {
        io.to(courseId).emit('reaction-update', { reactions: result.counts })
        io.to(courseId).emit('student-count', result.count)
        socket.emit('room-joined', result.roomJoined)
        log('info', 'student_joined', { sid: socket.id, courseId, studentId, count: result.count })
      } else if (result.kind === 'student-waiting') {
        socket.emit('session-waiting', result.waiting)
        log('info', 'student_waiting', { sid: socket.id, courseId })
      }
    }
    socket.on('join-course', handleJoin)
    socket.on('join-room', handleJoin)

    // 리액션 — 토글: 같은 색 다시 누르면 해제, 다른 색이면 변경
    socket.on('reaction', async ({ roomId, courseId, type } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (!['green', 'yellow', 'red'].includes(type)) return
      if (socket.data.currentCourseId !== cid) return
      if (!socket.data.studentId) return
      if (!rateLimit(socket, 'reaction', 50)) return

      let newCounts = null
      let myState = null
      await withCourseLock(cid, async () => {
        const course = await courseStore.get(cid)
        if (!course || !isSessionLive(course)) return
        const s = course.currentSession
        if (!s.students) s.students = {}
        const stu = s.students[socket.data.studentId]
        if (!stu) return
        stu.state = (stu.state === type) ? null : type
        stu.lastReactionAt = Date.now()
        recordChange(s)
        await courseStore.save(cid, course)
        newCounts = countStates(s.students)
        myState = stu.state
      })

      if (newCounts) {
        io.to(cid).emit('reaction-update', { reactions: newCounts })
        socket.emit('my-state', { state: myState })
      }
    })

    // 질문
    socket.on('question', async ({ roomId, courseId, text } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.currentCourseId !== cid) return
      if (!rateLimit(socket, 'question', 5_000)) {
        socket.emit('rate-limited', { event: 'question' })
        return
      }
      const trimmed = String(text || '').trim().substring(0, 50)
      if (!trimmed) return

      let question = null
      let questionCount = 0
      await withCourseLock(cid, async () => {
        const course = await courseStore.get(cid)
        if (!course || !isSessionLive(course)) return
        question = { id: generateQuestionId(), text: trimmed, timestamp: Date.now() }
        course.currentSession.questions.push(question)
        if (course.currentSession.questions.length > 200) {
          course.currentSession.questions = course.currentSession.questions.slice(-200)
        }
        recordChange(course.currentSession)
        await courseStore.save(cid, course)
        questionCount = course.currentSession.questions.length
      })

      if (question) {
        io.to(cid).emit('new-question', { question, questionCount })
      }
    })

    // 질문 dismiss (교수자) — 영구 삭제 X. dismissed=true 마킹.
    // 회차 archive 시 dismissed 포함 전체가 보존되어 학기말 검토에 남음.
    socket.on('dismiss-question', async ({ roomId, courseId, questionId } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.profOf !== cid) return
      if (!rateLimit(socket, 'dismiss', 200)) return

      let dismissed = false
      await withCourseLock(cid, async () => {
        const course = await courseStore.get(cid)
        if (!course?.currentSession) return
        const now = Date.now()
        course.currentSession.questions = course.currentSession.questions.map(q =>
          q.id === questionId ? { ...q, dismissed: true, dismissedAt: now } : q
        )
        await courseStore.save(cid, course)
        dismissed = true
      })
      if (dismissed) io.to(cid).emit('question-dismissed', { questionId })
    })

    // 강의 이름 변경 (교수자)
    socket.on('course-rename', async ({ courseId, ownerToken, name } = {}, callback) => {
      if (!rateLimit(socket, 'rename', 2000)) {
        if (typeof callback === 'function') callback({ error: 'rate_limited' })
        return
      }
      if (!validCourseId(courseId)) {
        if (typeof callback === 'function') callback({ error: 'invalid_room_id' })
        return
      }
      const course = await courseStore.get(courseId)
      if (!course) {
        if (typeof callback === 'function') callback({ error: 'room_not_found' })
        return
      }
      if (!validToken(ownerToken) || ownerToken !== course.ownerToken) {
        if (typeof callback === 'function') callback({ error: 'unauthorized' })
        return
      }
      const trimmed = typeof name === 'string' ? name.trim().substring(0, 60) : ''
      course.name = trimmed || null
      await courseStore.save(courseId, course)
      io.to(courseId).emit('course-renamed', { name: course.name })
      if (typeof callback === 'function') callback({ ok: true, name: course.name })
    })

    // 회차 삭제 (교수자) — archivedSessions에서 영구 제거
    socket.on('delete-archived-session', async ({ roomId, courseId, sessionId } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.profOf !== cid) {
        log('warn', 'unauthorized_action', { sid: socket.id, event: 'delete-archived-session', courseId: cid })
        return
      }
      if (!rateLimit(socket, 'delete-archived', 2000)) return
      if (typeof sessionId !== 'string' || !sessionId) return
      const course = await courseStore.get(cid)
      if (!course?.archivedSessions) return
      const before = course.archivedSessions.length
      course.archivedSessions = course.archivedSessions.filter(s => s.id !== sessionId)
      if (course.archivedSessions.length === before) return
      await courseStore.save(cid, course)
      io.to(cid).emit('archived-deleted', { sessionId })
      log('info', 'archived_deleted', { sid: socket.id, courseId: cid, sessionId })
    })

    // 명시적 시작 (교수자)
    socket.on('session-start', async ({ roomId, courseId } = {}, callback) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) { if (typeof callback === 'function') callback({ error: 'invalid_room_id' }); return }
      if (socket.data.profOf !== cid) { if (typeof callback === 'function') callback({ error: 'unauthorized' }); return }
      if (!rateLimit(socket, 'session-start', 2000)) { if (typeof callback === 'function') callback({ error: 'rate_limited' }); return }
      const course = await courseStore.get(cid)
      if (!course) { if (typeof callback === 'function') callback({ error: 'room_not_found' }); return }
      if (isSessionLive(course)) {
        if (typeof callback === 'function') callback({ ok: true, sessionId: course.currentSession.id, alreadyLive: true })
        return
      }
      course.currentSession = freshSession()
      await courseStore.save(cid, course)
      io.to(cid).emit('session-started', {
        sessionId: course.currentSession.id,
        startedAt: course.currentSession.startedAt,
      })
      log('info', 'session_started_explicit', { sid: socket.id, courseId: cid, sessionId: course.currentSession.id })
      if (typeof callback === 'function') callback({ ok: true, sessionId: course.currentSession.id })
    })

    // 명시적 종료 (교수자)
    socket.on('session-end', async ({ roomId, courseId } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.profOf !== cid) return
      if (!rateLimit(socket, 'session-end', 2000)) return
      const course = await courseStore.get(cid)
      if (!course?.currentSession || course.currentSession.endedAt) return
      const now = Date.now()
      course.currentSession.lastSeen = now
      course.currentSession.endedAt = now
      forceSnapshot(course.currentSession, now)
      const summary = summarizeSession(course.currentSession)
      course.archivedSessions = course.archivedSessions || []
      course.archivedSessions.push(summary)
      if (course.archivedSessions.length > ARCHIVE_LIMIT) {
        course.archivedSessions = course.archivedSessions.slice(-ARCHIVE_LIMIT)
      }
      const endedSessionId = course.currentSession.id
      course.currentSession = null
      await courseStore.save(cid, course)
      io.to(cid).emit('session-ended', { sessionId: endedSessionId, explicit: true })
      log('info', 'session_ended_explicit', { sid: socket.id, courseId: cid, sessionId: endedSessionId })
    })

    // disconnect — 학생: 해당 socket을 students[studentId].sockets에서 제거. sockets 비면 학생 삭제.
    socket.on('disconnect', async (reason) => {
      // IP 카운트 감소 (강의 외 처리와 별개로 항상)
      const ip = socket.data.ip
      if (ip) {
        const c = (ipConnCount.get(ip) || 1) - 1
        if (c <= 0) ipConnCount.delete(ip)
        else ipConnCount.set(ip, c)
      }

      const cid = socket.data.currentCourseId
      if (!cid) {
        log('info', 'socket_disconnect', { sid: socket.id, reason })
        return
      }

      let studentLeft = null
      await withCourseLock(cid, async () => {
        const course = await courseStore.get(cid)
        if (!course) return

        if (socket.data.currentRole === 'professor' && course.currentSession && !course.currentSession.endedAt) {
          course.currentSession.lastSeen = Date.now()
          await courseStore.save(cid, course)
          log('info', 'professor_disconnect', { courseId: cid, sessionId: course.currentSession.id })
        } else if (socket.data.currentRole === 'student' && course.currentSession?.students) {
          const sid = socket.data.studentId
          const stu = sid ? course.currentSession.students[sid] : null
          if (stu) {
            stu.sockets = stu.sockets.filter(x => x !== socket.id)
            if (stu.sockets.length === 0) delete course.currentSession.students[sid]
            recordChange(course.currentSession)
            await courseStore.save(cid, course)
            studentLeft = {
              counts: countStates(course.currentSession.students),
              count: studentCountOf(course.currentSession.students),
            }
          }
        }
      })

      if (studentLeft) {
        io.to(cid).emit('reaction-update', { reactions: studentLeft.counts })
        io.to(cid).emit('student-count', studentLeft.count)
      }
      log('info', 'socket_disconnect', { sid: socket.id, reason, courseId: cid })
    })
  })

  httpServer.listen(port, () => log('info', 'server_ready', { port, hostname }))
})
