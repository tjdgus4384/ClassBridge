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
// timeline은 변화 시점(reaction/join/leave)에만 push. 50ms 이내 변화는 덮어쓰기로 압축.
const TIMELINE_COMPRESS_MS = 50
const TIMELINE_MAX = 1000

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

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

function generateCourseId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = ''
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}
const generateQuestionId = () => crypto.randomBytes(4).toString('hex')
const generateOwnerToken = () => crypto.randomBytes(16).toString('hex')

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

  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : '*'
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
    log('info', 'socket_connect', { sid: socket.id })

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

      const course = await courseStore.get(courseId)
      if (!course) {
        socket.emit('join-error', { reason: 'room_not_found' })
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
      } else {
        // 학생 — studentId 필수
        if (!validStudentId(studentId)) {
          socket.emit('join-error', { reason: 'invalid_student_id' })
          return
        }
      }

      // 만료 lazy 판정
      const { expired, archivedSession } = archiveIfExpired(course)

      // 이전 강의에서 빠져나오기
      if (socket.data.currentCourseId && socket.data.currentCourseId !== courseId) {
        const prevId = socket.data.currentCourseId
        socket.leave(prevId)
        if (socket.data.currentRole === 'student' && socket.data.studentId) {
          const prev = await courseStore.get(prevId)
          if (prev?.currentSession?.students?.[socket.data.studentId]) {
            const stu = prev.currentSession.students[socket.data.studentId]
            stu.sockets = stu.sockets.filter(x => x !== socket.id)
            if (stu.sockets.length === 0) delete prev.currentSession.students[socket.data.studentId]
            await courseStore.save(prevId, prev)
            io.to(prevId).emit('reaction-update', { reactions: countStates(prev.currentSession.students) })
            io.to(prevId).emit('student-count', studentCountOf(prev.currentSession.students))
          }
        }
      }
      socket.data.currentCourseId = courseId
      socket.data.currentRole = role
      socket.data.studentId = role === 'student' ? studentId : null
      socket.join(courseId)

      if (expired) {
        io.to(courseId).emit('session-ended', { sessionId: archivedSession.id })
        log('info', 'session_archived', { courseId, sessionId: archivedSession.id })
      }

      if (role === 'professor') {
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
          reactions: s ? countStates(s.students) : { green: 0, yellow: 0, red: 0, none: 0 },
          questions: s ? s.questions : [],
          studentCount: s ? studentCountOf(s.students) : 0,
          archivedSessions: course.archivedSessions || [],
        })
        log('info', live ? 'session_resumed' : 'professor_review_mode',
          { courseId, sessionId: s?.id })
      } else {
        // 학생
        if (isSessionLive(course)) {
          const s = course.currentSession
          if (!s.students) s.students = {}
          let stu = s.students[studentId]
          if (!stu) {
            stu = { state: null, sockets: [socket.id], joinedAt: Date.now(), lastReactionAt: 0 }
            s.students[studentId] = stu
          } else {
            // 재접속 / 추가 디바이스 — 같은 studentId면 +1 X
            if (!stu.sockets.includes(socket.id)) stu.sockets.push(socket.id)
          }
          const count = studentCountOf(s.students)
          if (count > (s.peakStudentCount || 0)) s.peakStudentCount = count
          recordChange(s)
          await courseStore.save(courseId, course)

          io.to(courseId).emit('reaction-update', { reactions: countStates(s.students) })
          io.to(courseId).emit('student-count', count)
          socket.emit('room-joined', {
            ok: true,
            sessionId: s.id,
            startedAt: s.startedAt,
            myState: stu.state,
            reactions: countStates(s.students),
            name: course.name,
          })
          log('info', 'student_joined', { sid: socket.id, courseId, studentId, count })
        } else {
          socket.emit('session-waiting', { courseId, name: course.name })
        }
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

      io.to(cid).emit('reaction-update', { reactions: countStates(s.students) })
      socket.emit('my-state', { state: stu.state })
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
      const course = await courseStore.get(cid)
      if (!course || !isSessionLive(course)) return
      const question = { id: generateQuestionId(), text: trimmed, timestamp: Date.now() }
      course.currentSession.questions.push(question)
      if (course.currentSession.questions.length > 200) {
        course.currentSession.questions = course.currentSession.questions.slice(-200)
      }
      recordChange(course.currentSession)
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
      if (socket.data.profOf !== cid) return
      const course = await courseStore.get(cid)
      if (!course?.currentSession) return
      course.currentSession.questions = course.currentSession.questions.filter(q => q.id !== questionId)
      await courseStore.save(cid, course)
      io.to(cid).emit('question-dismissed', { questionId })
    })

    // 강의 이름 변경 (교수자)
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
      } else if (socket.data.currentRole === 'student' && course.currentSession?.students) {
        const sid = socket.data.studentId
        const stu = sid ? course.currentSession.students[sid] : null
        if (stu) {
          stu.sockets = stu.sockets.filter(x => x !== socket.id)
          if (stu.sockets.length === 0) delete course.currentSession.students[sid]
          recordChange(course.currentSession)
          await courseStore.save(cid, course)
          io.to(cid).emit('reaction-update', { reactions: countStates(course.currentSession.students) })
          io.to(cid).emit('student-count', studentCountOf(course.currentSession.students))
        }
      }
      log('info', 'socket_disconnect', { sid: socket.id, reason, courseId: cid })
    })
  })

  httpServer.listen(port, () => log('info', 'server_ready', { port, hostname }))
})
