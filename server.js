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
const REDIS_URL = process.env.REDIS_URL // Fly.io가 자동 주입
const COURSE_TTL = 60 * 60 * 24 * 365     // course는 1년 보관 (학기 4-5개월 안전)
const GRACE_MS = 60 * 60 * 1000           // 교수자 disconnect 후 1시간 grace
const ARCHIVE_LIMIT = 30                   // 회차 누적 상한

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// ─── 구조화 로그 ────────────────────────────────────────────────────────────
function log(level, event, data = {}) {
  try {
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...data }) + '\n')
  } catch {}
}

// ─── 검증 ──────────────────────────────────────────────────────────────────
const COURSE_ID_RE = /^[A-Z2-9]{6,8}$/
const validCourseId = id => typeof id === 'string' && COURSE_ID_RE.test(id)
const validToken = t => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t)

// ─── Course/Session 헬퍼 ───────────────────────────────────────────────────
function freshCourse(ownerToken) {
  return {
    schemaV: 2,
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
    reactions: { green: 0, yellow: 0, red: 0 },
    questions: [],
    studentCount: 0,
    peakStudentCount: 0,
    // 1분 간격 스냅샷 — 회차 히스토리 시계열 그래프용
    timeline: [{ t: now, reactions: { green: 0, yellow: 0, red: 0 }, studentCount: 0 }],
  }
}

const SNAPSHOT_INTERVAL_MS = 60 * 1000
const TIMELINE_MAX = 240

function maybeSnapshot(session, now = Date.now()) {
  if (!session.timeline) session.timeline = []
  const last = session.timeline[session.timeline.length - 1]
  if (!last || now - last.t >= SNAPSHOT_INTERVAL_MS) {
    session.timeline.push({
      t: now,
      reactions: { ...session.reactions },
      studentCount: session.studentCount || 0,
    })
    if (session.timeline.length > TIMELINE_MAX) {
      session.timeline = session.timeline.slice(-TIMELINE_MAX)
    }
  }
}

function summarizeSession(s) {
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    reactions: s.reactions,
    questionCount: s.questions.length,
    questions: s.questions, // 본문 보관 (Phase 2에서 30일 후 prune 예정)
    peakStudentCount: s.peakStudentCount,
    timeline: s.timeline || [],
  }
}

// 만료 판정 — 활성 세션이지만 grace 초과면 종료 처리. 부수효과로 archive 이동.
// 반환: { expired: boolean, archivedSession: SessionSummary | null }
function archiveIfExpired(course, now = Date.now()) {
  const s = course.currentSession
  if (!s || s.endedAt) return { expired: false, archivedSession: null }
  if (now - s.lastSeen <= GRACE_MS) return { expired: false, archivedSession: null }
  s.endedAt = s.lastSeen
  // 종료 시점의 마지막 스냅샷 (interval 무시)
  if (!s.timeline) s.timeline = []
  s.timeline.push({ t: s.lastSeen, reactions: { ...s.reactions }, studentCount: s.studentCount || 0 })
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

function generateCourseId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = ''
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}
const generateQuestionId = () => crypto.randomBytes(4).toString('hex')
const generateOwnerToken = () => crypto.randomBytes(16).toString('hex')

// ─── Rate limit (소켓 단위) ────────────────────────────────────────────────
function rateLimit(socket, key, minIntervalMs) {
  if (!socket.data.rl) socket.data.rl = {}
  const now = Date.now()
  const last = socket.data.rl[key] || 0
  if (now - last < minIntervalMs) return false
  socket.data.rl[key] = now
  return true
}

// ─── 부트 ───────────────────────────────────────────────────────────────────
app.prepare().then(async () => {
  const httpServer = createServer((req, res) => handle(req, res, parse(req.url, true)))

  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : '*'
  const io = new Server(httpServer, { cors: { origin: corsOrigins, methods: ['GET', 'POST'] } })

  // Redis
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

  // ─── 소켓 ────────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    log('info', 'socket_connect', { sid: socket.id })

    // 과목(course) 생성 — 교수자만 호출
    // 옛날 'create-room'도 호환성 유지
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
      // 호환: 옛날 클라는 res.roomId를 봄. 동일 키로 응답.
      if (typeof callback === 'function') {
        callback({ roomId: courseId, courseId, ownerToken })
      }
    }
    socket.on('create-course', handleCreate)
    socket.on('create-room', handleCreate)

    // 입장 — 학생/교수자 공통 진입점
    // 페이로드: { roomId|courseId, role, ownerToken? }
    const handleJoin = async (payload) => {
      const courseId = payload?.courseId || payload?.roomId
      const role = payload?.role
      const ownerToken = payload?.ownerToken

      if (!validCourseId(courseId)) {
        socket.emit('join-error', { reason: 'invalid_room_id' })
        log('warn', 'join_invalid_id', { sid: socket.id, courseId })
        return
      }
      if (role !== 'student' && role !== 'professor') {
        socket.emit('join-error', { reason: 'invalid_role' })
        return
      }

      const course = await courseStore.get(courseId)
      if (!course) {
        socket.emit('join-error', { reason: 'room_not_found' })
        log('warn', 'join_not_found', { sid: socket.id, courseId, role })
        return
      }

      // 교수자 인증
      if (role === 'professor') {
        if (!validToken(ownerToken) || ownerToken !== course.ownerToken) {
          socket.emit('join-error', { reason: 'unauthorized' })
          log('warn', 'join_unauthorized', { sid: socket.id, courseId })
          return
        }
        socket.data.profOf = courseId
      }

      // 만료 lazy 판정
      const { expired, archivedSession } = archiveIfExpired(course)

      // 이전 방 정리
      if (socket.data.currentCourseId && socket.data.currentCourseId !== courseId) {
        const prevId = socket.data.currentCourseId
        socket.leave(prevId)
        if (socket.data.currentRole === 'student') {
          const prev = await courseStore.get(prevId)
          if (prev?.currentSession) {
            prev.currentSession.studentCount = Math.max(0, prev.currentSession.studentCount - 1)
            await courseStore.save(prevId, prev)
            io.to(prevId).emit('student-count', prev.currentSession.studentCount)
          }
        }
      }
      socket.data.currentCourseId = courseId
      socket.data.currentRole = role
      socket.join(courseId)

      // 만료된 세션이 있었다면 모두에게 종료 알림
      if (expired) {
        io.to(courseId).emit('session-ended', { sessionId: archivedSession.id })
        log('info', 'session_archived', { courseId, sessionId: archivedSession.id })
      }

      if (role === 'professor') {
        // 자동 시작 X — 명시적 'session-start'로만 시작.
        // 단, grace 내 재접속이면 진행 중인 세션을 자연스럽게 이어감.
        const live = isSessionLive(course)
        if (live) {
          course.currentSession.lastSeen = Date.now()
          await courseStore.save(courseId, course)
        }

        const s = live ? course.currentSession : null
        socket.emit('room-state', {
          courseId,
          name: course.name,
          isLive: live,
          sessionId: s ? s.id : null,
          reactions: s ? s.reactions : { green: 0, yellow: 0, red: 0 },
          questions: s ? s.questions : [],
          studentCount: s ? s.studentCount : 0,
          archivedSessions: course.archivedSessions || [],
        })
        log('info', live ? 'session_resumed' : 'professor_review_mode',
          { courseId, sessionId: s?.id })
      } else {
        // 학생
        if (isSessionLive(course)) {
          const s = course.currentSession
          s.studentCount = (s.studentCount || 0) + 1
          if (s.studentCount > (s.peakStudentCount || 0)) s.peakStudentCount = s.studentCount
          maybeSnapshot(s)
          await courseStore.save(courseId, course)
          io.to(courseId).emit('student-count', s.studentCount)
          socket.emit('room-joined', {
            ok: true,
            sessionId: s.id,
            startedAt: s.startedAt,
            reactions: s.reactions,
          })
          log('info', 'student_joined', { sid: socket.id, courseId, count: s.studentCount })
        } else {
          // 대기실 진입
          socket.emit('session-waiting', { courseId })
          log('info', 'student_waiting', { sid: socket.id, courseId })
        }
      }
    }
    socket.on('join-course', handleJoin)
    socket.on('join-room', handleJoin)

    // 리액션 (학생)
    socket.on('reaction', async ({ roomId, courseId, type } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (!['green', 'yellow', 'red'].includes(type)) return
      if (socket.data.currentCourseId !== cid) return
      if (!rateLimit(socket, 'reaction', 800)) {
        log('warn', 'rate_limited', { sid: socket.id, event: 'reaction', courseId: cid })
        return
      }
      const course = await courseStore.get(cid)
      if (!course || !isSessionLive(course)) return
      course.currentSession.reactions[type]++
      maybeSnapshot(course.currentSession)
      await courseStore.save(cid, course)
      io.to(cid).emit('reaction-update', { reactions: course.currentSession.reactions })
    })

    // 질문 (학생)
    socket.on('question', async ({ roomId, courseId, text } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.currentCourseId !== cid) return
      if (!rateLimit(socket, 'question', 5_000)) {
        log('warn', 'rate_limited', { sid: socket.id, event: 'question', courseId: cid })
        socket.emit('rate-limited', { event: 'question' })
        return
      }
      const trimmed = String(text || '').trim().substring(0, 50)
      if (!trimmed) return
      const course = await courseStore.get(cid)
      if (!course || !isSessionLive(course)) return
      const question = { id: generateQuestionId(), text: trimmed, timestamp: Date.now() }
      course.currentSession.questions.push(question)
      if (course.currentSession.questions.length > 200) {
        course.currentSession.questions = course.currentSession.questions.slice(-200)
      }
      maybeSnapshot(course.currentSession)
      await courseStore.save(cid, course)
      io.to(cid).emit('new-question', {
        question,
        questionCount: course.currentSession.questions.length,
      })
    })

    // 질문 dismiss (교수자)
    socket.on('dismiss-question', async ({ roomId, courseId, questionId } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.profOf !== cid) {
        log('warn', 'unauthorized_action', { sid: socket.id, event: 'dismiss-question', courseId: cid })
        return
      }
      const course = await courseStore.get(cid)
      if (!course?.currentSession) return
      course.currentSession.questions = course.currentSession.questions.filter(q => q.id !== questionId)
      await courseStore.save(cid, course)
      io.to(cid).emit('question-dismissed', { questionId })
    })

    // 리액션 초기화 (교수자)
    socket.on('clear-reactions', async ({ roomId, courseId } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.profOf !== cid) {
        log('warn', 'unauthorized_action', { sid: socket.id, event: 'clear-reactions', courseId: cid })
        return
      }
      const course = await courseStore.get(cid)
      if (!course?.currentSession) return
      course.currentSession.reactions = { green: 0, yellow: 0, red: 0 }
      await courseStore.save(cid, course)
      io.to(cid).emit('reaction-update', { reactions: course.currentSession.reactions })
    })

    // 강의 이름 변경 (교수자) — ownerToken으로 직접 인증, 위젯 join 전에도 호출 가능
    socket.on('course-rename', async ({ courseId, ownerToken, name } = {}, callback) => {
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
        log('warn', 'rename_unauthorized', { sid: socket.id, courseId })
        return
      }
      const trimmed = typeof name === 'string' ? name.trim().substring(0, 60) : ''
      course.name = trimmed || null
      await courseStore.save(courseId, course)
      io.to(courseId).emit('course-renamed', { name: course.name })
      log('info', 'course_renamed', { courseId, hasName: !!course.name })
      if (typeof callback === 'function') callback({ ok: true, name: course.name })
    })

    // 명시적 세션 시작 (교수자) — "수업 시작" 버튼
    socket.on('session-start', async ({ roomId, courseId } = {}, callback) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) {
        if (typeof callback === 'function') callback({ error: 'invalid_room_id' })
        return
      }
      if (socket.data.profOf !== cid) {
        if (typeof callback === 'function') callback({ error: 'unauthorized' })
        log('warn', 'unauthorized_action', { sid: socket.id, event: 'session-start', courseId: cid })
        return
      }
      const course = await courseStore.get(cid)
      if (!course) {
        if (typeof callback === 'function') callback({ error: 'room_not_found' })
        return
      }
      // 이미 라이브면 멱등 — 현재 세션을 그대로 알려줌
      if (isSessionLive(course)) {
        const s = course.currentSession
        if (typeof callback === 'function') callback({ ok: true, sessionId: s.id, alreadyLive: true })
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

    // 명시적 세션 종료 (교수자) — "수업 종료" 버튼 / 위젯 ✕ / Cmd+Q
    socket.on('session-end', async ({ roomId, courseId } = {}) => {
      const cid = courseId || roomId
      if (!validCourseId(cid)) return
      if (socket.data.profOf !== cid) return
      const course = await courseStore.get(cid)
      if (!course?.currentSession || course.currentSession.endedAt) return
      const now = Date.now()
      course.currentSession.lastSeen = now
      course.currentSession.endedAt = now
      if (!course.currentSession.timeline) course.currentSession.timeline = []
      course.currentSession.timeline.push({
        t: now,
        reactions: { ...course.currentSession.reactions },
        studentCount: course.currentSession.studentCount || 0,
      })
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

    // 연결 해제 — 교수자: lastSeen만 갱신 (lazy 종료). 학생: studentCount 감소.
    socket.on('disconnect', async (reason) => {
      const cid = socket.data.currentCourseId
      if (!cid) {
        log('info', 'socket_disconnect', { sid: socket.id, reason })
        return
      }
      const course = await courseStore.get(cid)
      if (!course) return

      if (socket.data.currentRole === 'professor' && course.currentSession && !course.currentSession.endedAt) {
        course.currentSession.lastSeen = Date.now()
        await courseStore.save(cid, course)
        log('info', 'professor_disconnect', { courseId: cid, sessionId: course.currentSession.id })
      } else if (socket.data.currentRole === 'student' && course.currentSession) {
        course.currentSession.studentCount = Math.max(0, (course.currentSession.studentCount || 0) - 1)
        maybeSnapshot(course.currentSession)
        await courseStore.save(cid, course)
        io.to(cid).emit('student-count', course.currentSession.studentCount)
      }
      log('info', 'socket_disconnect', { sid: socket.id, reason, courseId: cid })
    })
  })

  httpServer.listen(port, () => log('info', 'server_ready', { port, hostname }))
})
