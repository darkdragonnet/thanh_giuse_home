import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  StudentRepository,
  ClassRepository,
  SettingsRepository,
  LogRepository,
  createRedisClient,
  closeRedisClient,
  validateStudentIdentifier,
} from '@thanh-giuse/shared-infra';
import { apiEnv } from './config.js';
import { createKillSwitchGuard, createClassLockGuard } from './middleware/guards.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { createRegistrationQueue } from './queue.js';
import { AdminRequestRepository } from './repositories/admin-request.repository.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import { giatruongRoutes } from './routes/giatruong.js';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const server = Fastify({
  logger: true,
  trustProxy: true,
});

// Chống lỗi FST_ERR_CTP_EMPTY_JSON_BODY khi client gửi header Content-Type application/json nhưng body rỗng
server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string | Buffer, done) => {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  if (!text || text.trim() === '') {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(text));
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

// 1. Kết nối Hạ tầng Cơ sở Dữ liệu & Redis
const pool = new Pool({
  connectionString: apiEnv.db.connectionString,
  max: apiEnv.db.max,
  idleTimeoutMillis: apiEnv.db.idleTimeoutMillis,
  connectionTimeoutMillis: apiEnv.db.connectionTimeoutMillis,
});

export const redisClient = createRedisClient(apiEnv.redis);
export const studentRepo = new StudentRepository(pool);
export const classRepo = new ClassRepository(pool);
export const settingsRepo = new SettingsRepository(pool);
export const logRepo = new LogRepository(pool);
export const adminRequestRepo = new AdminRequestRepository(pool);
export const registrationQueue = createRegistrationQueue(redisClient);

// Thư mục lưu ảnh upload
const UPLOAD_DIR = apiEnv.uploadDir;
const TMP_FACES_DIR = path.join(UPLOAD_DIR, 'tmp-faces');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(TMP_FACES_DIR)) {
  fs.mkdirSync(TMP_FACES_DIR, { recursive: true });
}

// 2. Khởi tạo Middlewares & Guards
const killSwitchGuard = createKillSwitchGuard(settingsRepo);
const classLockGuard = createClassLockGuard(classRepo, studentRepo);
const rateLimiter = createRateLimiter({
  redis: redisClient,
  classRepo,
  studentRepo,
  adminSecret: apiEnv.jwtSecret,
  limit: 5,
  windowSec: 300,
});

// 3. Đăng ký Fastify Plugins
await server.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

const publicPath = path.resolve(__dirname, '../public');
if (!fs.existsSync(publicPath)) {
  fs.mkdirSync(publicPath, { recursive: true });
}

await server.register(fastifyStatic, {
  root: publicPath,
  prefix: '/',
  decorateReply: false,
});

// Phục vụ ảnh tạm (tmp-faces) và ảnh lưu trữ trực tiếp từ Fastify API (Fallback cứu hộ khi proxy bypass)
await server.register(fastifyStatic, {
  root: TMP_FACES_DIR,
  prefix: '/tmp-faces/',
  decorateReply: false,
});

await server.register(fastifyStatic, {
  root: UPLOAD_DIR,
  prefix: '/uploads/',
  decorateReply: false,
});

// Decorate các dịch vụ vào server Fastify
server.decorate('classRepo', classRepo);
server.decorate('studentRepo', studentRepo);
server.decorate('logRepo', logRepo);
server.decorate('adminRequestRepo', adminRequestRepo);
server.decorate('settingsRepo', settingsRepo);
server.decorate('registrationQueue', registrationQueue);
server.decorate('redis', redisClient);
server.decorate('pg', pool);

// Đăng ký toàn bộ Admin Routes (/api/admin/*)
await server.register(adminRoutes, { prefix: '/api/admin' });

// Đăng ký Webhook Receiver (/api/webhooks/*)
await server.register(webhookRoutes, { prefix: '/api/webhooks' });

// =============================================================================
// HỆ THỐNG BỎ PHIẾU BAN ĐẠI DIỆN GIA TRƯỞNG (MODULE MƯỢN DOCKER SERVICE)
// =============================================================================
const giatruongPublicPath = path.resolve(__dirname, '../public/giatruong');
if (!fs.existsSync(giatruongPublicPath)) {
  fs.mkdirSync(giatruongPublicPath, { recursive: true });
}

await server.register(fastifyStatic, {
  root: giatruongPublicPath,
  prefix: '/giatruong/',
  decorateReply: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
});

server.get('/giatruong', async (_req, reply) => {
  return reply.redirect('/giatruong/');
});

server.get('/giatruong/ket-qua', async (_req, reply) => {
  return reply.redirect('/giatruong/admin.html');
});

// Đăng ký toàn bộ API Bỏ Phiếu Gia Trưởng (/giatruong/api/*)
await server.register(giatruongRoutes, { prefix: '/giatruong/api' });

// Hàm tiện ích mã hóa an toàn Header ASCII (RFC 7230 / RFC 8187)
// Triệt tiêu lỗi TypeError [ERR_INVALID_CHAR] và chống CRLF Header Injection (\r\n -> %0D%0A)
export function safeHeaderEncode(text: string | null | undefined): string {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  return encodeURIComponent(trimmed);
}

// Helper trích xuất mã PIN giáo viên từ Header hoặc Query
function extractTeacherPin(request: any): string {
  const raw =
    (request.headers?.['x-teacher-pin'] as string) ||
    (request.query as Record<string, string>)?.teacher_pin ||
    (request.query as Record<string, string>)?.token ||
    '';
  return String(raw).trim();
}

// Helper đính kèm CORS & Exposed Headers chuẩn Production
function applyClassPortalHeaders(
  reply: any,
  classCode: string | null | undefined,
  className: string | null | undefined,
  isTeacherVerified: boolean
) {
  const safeCode = String(classCode || '')
    .replace(/[\r\n]/g, '')
    .trim()
    .toUpperCase();
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-teacher-pin');
  reply.header('Access-Control-Expose-Headers', 'X-Class-Code, X-Class-Name, X-Teacher-Verified');
  reply.header('X-Class-Code', safeCode);
  reply.header('X-Class-Name', safeHeaderEncode(className));
  reply.header('X-Teacher-Verified', isTeacherVerified ? 'true' : 'false');
}

// 4a. Hỗ trợ CORS Preflight OPTIONS cho route danh sách học sinh theo lớp
server.options<{ Params: { classId: string } }>(
  '/api/classes/:classId/students',
  async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-teacher-pin');
    reply.header('Access-Control-Expose-Headers', 'X-Class-Code, X-Class-Name, X-Teacher-Verified');
    return reply.status(204).send();
  }
);

// 4b. API Lấy danh sách học sinh theo lớp (Hỗ trợ cả classId số và classCode chuỗi như GLV0, TS1A)
server.get<{ Params: { classId: string } }>(
  '/api/classes/:classId/students',
  {
    preHandler: [killSwitchGuard, classLockGuard],
  },
  async (request, reply) => {
    const rawParam = request.params.classId.trim();
    const numericClassId = parseInt(rawParam, 10);
    const teacherPin = extractTeacherPin(request);

    if (!isNaN(numericClassId) && String(numericClassId) === rawParam) {
      const classRecord =
        typeof classRepo.findById === 'function' ? await classRepo.findById(numericClassId) : null;
      const isTeacherVerified =
        Boolean(teacherPin && classRecord && typeof classRepo.verifyTeacherPin === 'function')
          ? await classRepo.verifyTeacherPin(classRecord!.id, teacherPin)
          : false;

      applyClassPortalHeaders(
        reply,
        classRecord?.code || String(numericClassId),
        classRecord?.name ?? null,
        isTeacherVerified
      );
      const students = await studentRepo.getStudentsByClassId(numericClassId);
      return reply.send(students);
    }

    const classRecord = await classRepo.findByCode(rawParam.toUpperCase());
    if (!classRecord) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Không tìm thấy lớp học với mã "${rawParam}".`,
      });
    }

    const isTeacherVerified =
      Boolean(teacherPin && typeof classRepo.verifyTeacherPin === 'function')
        ? await classRepo.verifyTeacherPin(classRecord.id, teacherPin)
        : false;

    applyClassPortalHeaders(reply, rawParam.toUpperCase(), classRecord.name, isTeacherVerified);
    const students = await studentRepo.getStudentsByClassId(classRecord.id);
    return reply.send(students);
  }
);

// Helper xử lý Luồng 1: Nộp ảnh học sinh theo lớp (Atomic Lock chống ghi đè + Hỗ trợ Teacher PIN Override)
async function handleClassStudentPhotoUpload(
  request: any,
  reply: any
) {
  const studentId = parseInt(request.params.studentId, 10);

  // A. Đọc file tải lên
  const data = await request.file();
  if (!data) {
    return reply.status(400).send({ message: 'Vui lòng chọn ảnh tải lên.' });
  }

  const filename = `student_${studentId}_${Date.now()}.jpg`;
  const filePath = path.join(UPLOAD_DIR, filename);

  await new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    data.file.pipe(writeStream);
    writeStream.on('finish', () => resolve());
    writeStream.on('error', reject);
  });

  // B. Kiểm tra mã PIN Giáo viên (Nếu có PIN hợp lệ của lớp -> cho phép cập nhật lại ảnh học sinh đã 'success')
  const teacherPin = extractTeacherPin(request);
  let isTeacherVerified = false;
  if (teacherPin && typeof studentRepo.findById === 'function' && typeof classRepo.verifyTeacherPin === 'function') {
    const targetStudent = await studentRepo.findById(studentId);
    if (targetStudent) {
      isTeacherVerified = await classRepo.verifyTeacherPin(targetStudent.class_id, teacherPin);
    }
  }

  let claimed: any = null;
  let mode: 'REGISTER' | 'UPDATE_PHOTO' = 'REGISTER';

  if (isTeacherVerified && typeof (studentRepo as any).claimStudentForTeacherOverride === 'function') {
    const overrideRes = await studentRepo.claimStudentForTeacherOverride(studentId, filePath);
    if (overrideRes) {
      claimed = overrideRes.student;
      mode = overrideRes.mode;
    }
  } else {
    // Học sinh tự nộp (Không có PIN hoặc PIN sai): Chỉ cho phép 'empty'|'error'|'manual_review' -> 'pending'
    // Khóa cứng nếu status = 'success' (HTTP 409 Conflict)
    claimed = await studentRepo.claimStudentForUpload(studentId, filePath);
  }

  if (!claimed) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return reply.status(409).send({
      error: 'Conflict',
      message: 'Học sinh này đã được đăng ký hoặc đang trong quá trình xử lý.',
    });
  }

  // C. Tìm mã lớp của học sinh
  const classRecord = await classRepo.findById(claimed.class_id);
  const classCode = classRecord ? classRecord.code : 'UNKNOWN';

  // D. Đẩy job vào hàng đợi BullMQ (Idempotent JobID ưu tiên qr_token hoặc alias_id)
  const safeIdentifier = claimed.alias_id || claimed.qr_token || String(claimed.id);
  const isUpdatePhoto = mode === 'UPDATE_PHOTO' && Boolean(claimed.person_id);
  const actionType = isUpdatePhoto ? 'UPDATE_PHOTO' : 'REGISTER';
  const priority = isUpdatePhoto ? 1 : 5;
  const jobId = isUpdatePhoto
    ? `teacher_override_${safeIdentifier}_${Date.now()}`
    : `student_${safeIdentifier}`;

  const job = await registrationQueue.add(
    isUpdatePhoto ? 'override-photo' : 'register',
    {
      studentId: claimed.id,
      aliasId: claimed.alias_id,
      qrToken: claimed.qr_token,
      studentName: claimed.name,
      classCode,
      tempFilename: filename,
      uploadedAt: Date.now(),
      actionType,
      ...(claimed.person_id ? { personId: claimed.person_id } : {}),
    },
    {
      jobId,
      priority, // Priority = 1 nếu Giáo viên cập nhật ảnh, Priority = 5 nếu đăng ký mới
      removeOnComplete: true,
    }
  );

  // E. Ghi Audit Log (bảo toàn khóa ngoại student_id ngay cả khi alias_id = NULL)
  await logRepo.recordLog({
    student_id: claimed.id,
    alias_id: claimed.alias_id,
    class_id: claimed.class_id,
    action: actionType,
    result_code: isUpdatePhoto ? 'QUEUED_TEACHER_OVERRIDE' : 'QUEUED',
    result_message: isUpdatePhoto
      ? `Giáo viên cập nhật ảnh qua PIN lớp (Job ID: ${job.id})`
      : `Ảnh đã được lưu và đưa vào hàng đợi BullMQ (Job ID: ${job.id})`,
    ip: request.ip,
  });

  return reply.status(200).send({
    success: true,
    message: isUpdatePhoto
      ? 'Cập nhật ảnh thành công! Yêu cầu của Giáo viên đã vào hàng đợi ưu tiên.'
      : 'Nộp ảnh thành công! Yêu cầu đã vào hàng đợi xử lý.',
    jobId: job.id,
    student: claimed,
  });
}

// 5. API Nộp ảnh học sinh Luồng 1 (Hỗ trợ cả /photo và /register)
server.post<{ Params: { studentId: string } }>(
  '/api/students/:studentId/photo',
  {
    preHandler: [killSwitchGuard, classLockGuard, rateLimiter],
  },
  handleClassStudentPhotoUpload
);

server.post<{ Params: { studentId: string } }>(
  '/api/students/:studentId/register',
  {
    preHandler: [killSwitchGuard, classLockGuard, rateLimiter],
  },
  handleClassStudentPhotoUpload
);

// 5b. Luồng 2: API Tra cứu & Tự cập nhật ảnh cá nhân qua QR Token (/u/:qr_token)
server.get<{ Params: { qrToken: string } }>(
  '/api/students/token/:qrToken',
  {
    preHandler: [killSwitchGuard, classLockGuard],
  },
  async (request, reply) => {
    const qrToken = request.params.qrToken.trim();
    const student = await studentRepo.findByQrToken(qrToken);
    if (!student) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Mã định danh cá nhân (QR Token) không tồn tại.',
      });
    }

    const classRecord = await classRepo.findById(student.class_id);
    return reply.status(200).send({
      success: true,
      student,
      classInfo: classRecord
        ? { id: classRecord.id, code: classRecord.code, name: classRecord.name }
        : null,
    });
  }
);

server.post<{ Params: { qrToken: string } }>(
  '/api/students/token/:qrToken/photo',
  {
    preHandler: [killSwitchGuard, classLockGuard, rateLimiter],
  },
  async (request, reply) => {
    const qrToken = request.params.qrToken.trim();

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'Vui lòng chọn ảnh tải lên.' });
    }

    const filename = `token_${qrToken}_${Date.now()}.jpg`;
    const filePath = path.join(UPLOAD_DIR, filename);

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      data.file.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    // Atomic Lock Luồng 2: Cho phép cả học sinh đã 'success' tự cập nhật ảnh (is_updating = TRUE)
    const claimResult = await studentRepo.claimStudentForTokenSelfService(qrToken, filePath);
    if (!claimResult) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const existing = await studentRepo.findByQrToken(qrToken);
      if (!existing) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Không tìm thấy học sinh tương ứng với mã QR Token này.',
        });
      }
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Hồ sơ của bạn đang trong quá trình xử lý ảnh trước đó. Vui lòng đợi giây lát.',
      });
    }

    const { student: claimed, mode } = claimResult;
    const classRecord = await classRepo.findById(claimed.class_id);
    const classCode = classRecord ? classRecord.code : 'UNKNOWN';
    const isUpdatePhoto = mode === 'UPDATE_PHOTO' || Boolean(claimed.person_id);
    const actionType = isUpdatePhoto ? 'UPDATE_PHOTO' : 'REGISTER';
    const priority = isUpdatePhoto ? 1 : 5;


    const job = await registrationQueue.add(
      isUpdatePhoto ? 'update-photo-self' : 'register',
      {
        studentId: claimed.id,
        aliasId: claimed.alias_id,
        qrToken: claimed.qr_token,
        studentName: claimed.name,
        classCode,
        tempFilename: filename,
        uploadedAt: Date.now(),
        actionType,
        ...(claimed.person_id ? { personId: claimed.person_id } : {}),
      },
      {
        jobId: `token_${claimed.qr_token}_${Date.now()}`,
        priority,
        removeOnComplete: true,
      }
    );

    await logRepo.recordLog({
      student_id: claimed.id,
      alias_id: claimed.alias_id,
      class_id: claimed.class_id,
      action: actionType,
      result_code: 'QUEUED_SELF_SERVICE',
      result_message: `Học sinh nộp/cập nhật ảnh qua QR Token (Job ID: ${job.id})`,
      ip: request.ip,
    });

    return reply.status(200).send({
      success: true,
      message: isUpdatePhoto
        ? 'Yêu cầu đổi ảnh mới đã được đưa vào hàng đợi ưu tiên.'
        : 'Nộp ảnh đăng ký thành công! Yêu cầu đã vào hàng đợi xử lý.',
      jobId: job.id,
      student: claimed,
    });
  }
);

// 6. Endpoint Admin Cập nhật ảnh ưu tiên (Priority Job = 1)
server.post<{ Params: { studentId: string } }>(
  '/api/admin/students/:studentId/override-photo',
  async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
    if (!token || token !== apiEnv.jwtSecret) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Yêu cầu quyền Quản trị viên.' });
    }

    const studentId = parseInt(request.params.studentId, 10);
    const student = await studentRepo.findById(studentId);
    if (!student) {
      return reply.status(404).send({ error: 'Not Found', message: 'Không tìm thấy học sinh.' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'Vui lòng chọn ảnh thay thế.' });
    }

    const safeId = student.alias_id || student.qr_token || String(student.id);
    const filename = `student_${safeId}_override_${Date.now()}.jpg`;
    const filePath = path.join(UPLOAD_DIR, filename);

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      data.file.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    // Cập nhật trạng thái pending
    const claimed = await studentRepo.claimStudentForUpload(studentId, filePath);
    const classRecord = await classRepo.findById(student.class_id);

    // Đẩy job với độ ưu tiên cao (priority = 1)
    const job = await registrationQueue.add(
      'override-photo',
      {
        studentId: student.id,
        aliasId: student.alias_id,
        qrToken: student.qr_token,
        studentName: student.name,
        classCode: classRecord?.code || 'UNKNOWN',
        tempFilename: filename,
        uploadedAt: Date.now(),
        actionType: 'UPDATE_PHOTO',
        ...(student.person_id ? { personId: student.person_id } : {}),
      },
      {
        jobId: `student_${safeId}_override_${Date.now()}`,
        priority: 1, // Admin priority job
        removeOnComplete: true,
      }
    );

    await logRepo.recordLog({
      student_id: student.id,
      alias_id: student.alias_id,
      class_id: student.class_id,
      action: 'UPDATE_PHOTO',
      result_code: 'QUEUED_ADMIN',
      result_message: `Admin đẩy job cập nhật ảnh ưu tiên (Job ID: ${job.id})`,
      ip: request.ip,
    });

    return reply.status(200).send({
      success: true,
      message: 'Ảnh đã được tiếp nhận và đẩy vào hàng đợi ưu tiên cao.',
      jobId: job.id,
      student: claimed || student,
    });
  }
);

// 7. Yêu cầu hỗ trợ Admin từ học sinh (Rate limit: 5 lần/giờ/học sinh)
server.post(
  '/api/admin-requests',
  async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'Vui lòng đính kèm ảnh chân dung cần hỗ trợ.' });
    }

    const fields: Record<string, string> = {};
    for (const [key, field] of Object.entries(data.fields)) {
      if ((field as any)?.value !== undefined) {
        fields[key] = String((field as any).value);
      }
    }

    const aliasId = fields.alias_id || fields.aliasId || null;
    const qrToken = fields.qr_token || fields.qrToken || null;
    const rawStudentId = fields.student_id || fields.studentId || null;
    const rateKeyId = aliasId || qrToken || rawStudentId;

    if (!rateKeyId) {
      return reply.status(400).send({ message: 'Thiếu định danh học sinh (alias_id, qr_token hoặc student_id).' });
    }

    // Rate Limit: 5 lần / giờ / định danh học sinh
    const rateLimitKey = `ratelimit:admin_req:${rateKeyId}`;
    const currentAttempts = await redisClient.incr(rateLimitKey);
    if (currentAttempts === 1) {
      await redisClient.expire(rateLimitKey, 3600);
    }
    if (currentAttempts > 5) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: 'Bạn đã gửi tối đa 5 yêu cầu hỗ trợ trong 1 giờ qua. Vui lòng chờ phản hồi từ quản trị viên.',
      });
    }

    const filename = `admin_req_${rateKeyId}_${Date.now()}.jpg`;
    const filePath = path.join(UPLOAD_DIR, filename);

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      data.file.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    let studentRecord = aliasId ? await studentRepo.findByAliasId(aliasId) : null;
    if (!studentRecord && qrToken && typeof studentRepo.findByQrToken === 'function') {
      studentRecord = await studentRepo.findByQrToken(qrToken);
    }
    if (!studentRecord && rawStudentId) {
      const parsedId = parseInt(rawStudentId, 10);
      if (!isNaN(parsedId)) {
        studentRecord = await studentRepo.findById(parsedId);
      }
    }

    const created = await adminRequestRepo.createRequest({
      student_id: studentRecord ? studentRecord.id : null,
      alias_id: aliasId || (studentRecord ? studentRecord.alias_id : null),
      class_id: studentRecord ? studentRecord.class_id : undefined,
      student_name: fields.student_name || fields.studentName || (studentRecord ? studentRecord.name : undefined),
      image_path: filePath,
      note: fields.note || undefined,
      ip: request.ip,
    });

    await logRepo.recordLog({
      student_id: studentRecord?.id ?? null,
      alias_id: aliasId || studentRecord?.alias_id || null,
      class_id: studentRecord?.class_id,
      action: 'ADMIN_REQUEST_CREATED',
      result_code: 'SUCCESS',
      result_message: `Học sinh gửi yêu cầu hỗ trợ (ID: ${created.id}, ghi chú: ${fields.note || 'Không có'})`,
      ip: request.ip,
    });

    return reply.status(201).send({
      success: true,
      message: 'Đã gửi yêu cầu hỗ trợ thành công tới quản trị viên!',
      data: created,
    });
  }
);


// 7. API Nộp hồ sơ đăng ký học sinh mới (Kiểm tra chuẩn 9 ký tự và cô lập legacy format)
server.post<{
  Body: {
    classCode?: string;
    name?: string;
    aliasId?: string;
    imageFileUrl?: string;
  };
}>('/api/registration/submit', async (request, reply) => {
  const { classCode, name, aliasId, imageFileUrl } = request.body || {};

  if (!aliasId || !name) {
    return reply.status(400).send({
      success: false,
      error: 'MISSING_REQUIRED_FIELDS',
      message: 'Vui lòng cung cấp đầy đủ họ tên và mã định danh (aliasId).',
    });
  }

  // Kiểm tra định dạng mã định danh 9 ký tự
  const validation = validateStudentIdentifier(aliasId, 'PRE_SUBMIT_ANCHOR');
  if (!validation.isValid) {
    return reply.status(422).send({
      success: false,
      error: validation.errorCode,
      message: validation.message,
      isLockedForManualEdit: validation.isLockedForManualEdit || false,
    });
  }

  // Đẩy job vào BullMQ hàng đợi đăng ký
  const jobId = `student_${aliasId}`;
  const job = await registrationQueue.add(
    'register',
    {
      studentId: 0,
      aliasId,
      studentName: name,
      classCode: classCode || 'DEFAULT',
      tempFilename: '',
      faceImageUrl: imageFileUrl || '',
      uploadedAt: Date.now(),
      actionType: 'REGISTER',
    },
    {
      jobId,
      removeOnComplete: true,
    }
  );

  return reply.status(200).send({
    success: true,
    message: 'Nộp hồ sơ đăng ký thành công! Yêu cầu đã vào hàng đợi xử lý.',
    jobId: job.id,
    data: {
      classCode,
      name,
      aliasId,
    },
  });
});

// 7a. Cổng Danh Sách Lớp Công Khai (/classes)
server.get('/classes', async (_request, reply) => {
  const filePath = path.join(publicPath, 'classes.html');
  reply.type('text/html');
  return reply.send(fs.readFileSync(filePath, 'utf-8'));
});

server.get('/classes/', async (_request, reply) => {
  const filePath = path.join(publicPath, 'classes.html');
  reply.type('text/html');
  return reply.send(fs.readFileSync(filePath, 'utf-8'));
});

// 7b. API Thống Kê Public: Trả JSON tiến độ 29 lớp (không lộ PIN)
server.options('/api/public/classes', async (_request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  reply.header(
    'Access-Control-Expose-Headers',
    'X-Total-Classes, X-Total-Students, X-Total-Success, X-Overall-Rate'
  );
  return reply.status(204).send();
});

server.get('/api/public/classes', async (_request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  reply.header(
    'Access-Control-Expose-Headers',
    'X-Total-Classes, X-Total-Students, X-Total-Success, X-Overall-Rate'
  );
  reply.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=10');

  try {
    const rawClasses = await classRepo.getClassesWithStats();
    const classes = rawClasses.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      teacher_name: c.teacher_name || '',
      is_locked: c.is_locked,
      total_students: Number(c.total_students) || 0,
      success_count: Number(c.success_count) || 0,
      pending_count: Number(c.pending_count) || 0,
      error_count: Number(c.error_count) || 0,
      manual_review_count: Number(c.manual_review_count) || 0,
      empty_count: Number(c.empty_count) || 0,
      completion_rate:
        Number(c.total_students) > 0
          ? Math.round((Number(c.success_count) / Number(c.total_students)) * 100)
          : 0,
    }));

    const totalStudents = classes.reduce((sum, c) => sum + c.total_students, 0);
    const totalSuccess = classes.reduce((sum, c) => sum + c.success_count, 0);
    const overallRate = totalStudents > 0 ? Math.round((totalSuccess / totalStudents) * 100) : 0;

    reply.header('X-Total-Classes', String(classes.length));
    reply.header('X-Total-Students', String(totalStudents));
    reply.header('X-Total-Success', String(totalSuccess));
    reply.header('X-Overall-Rate', String(overallRate));

    return reply.status(200).send(classes);
  } catch (err: any) {
    server.log.error(err, 'Lỗi khi lấy danh sách public classes');
    return reply.status(500).send({
      success: false,
      error: 'Internal Server Error',
      message: 'Không thể tải thống kê danh sách lớp.',
    });
  }
});

// 8. API Health Check
server.get('/health', async (_request, reply) => {
  return reply.status(200).send({
    status: 'ok',
    serviceStatus: 'UP',
    service: 'thanh-giuse-api',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    redis: redisClient.status,
  });
});

server.get('/api/health', async (_request, reply) => {
  return reply.status(200).send({
    status: 'ok',
    serviceStatus: 'UP',
    service: 'thanh-giuse-api',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    redis: redisClient.status,
  });
});

const PORT = apiEnv.port;
const HOST = apiEnv.host;

export async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 API Server đang chạy tại: http://localhost:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Graceful Shutdown
const shutdown = async (signal: string) => {
  console.log(`[API] Nhận tín hiệu ${signal}, đóng kết nối an toàn...`);
  try {
    await server.close();
    await registrationQueue.close();
    await closeRedisClient(redisClient);
    await pool.end();
    console.log('[API] Đã đóng toàn bộ tài nguyên API');
    process.exit(0);
  } catch (err) {
    console.error('[API] Lỗi khi shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
