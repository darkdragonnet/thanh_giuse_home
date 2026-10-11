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

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const server = Fastify({
  logger: true,
  trustProxy: true,
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

// 4. API Lấy danh sách học sinh theo lớp
server.get<{ Params: { classId: string } }>(
  '/api/classes/:classId/students',
  {
    preHandler: [killSwitchGuard, classLockGuard],
  },
  async (request, reply) => {
    const classId = parseInt(request.params.classId, 10);
    const students = await studentRepo.getStudentsByClassId(classId);
    return reply.send(students);
  }
);

// 5. API Nộp ảnh học sinh (Rate Limited + Atomic Lock + BullMQ Enqueue)
server.post<{ Params: { studentId: string } }>(
  '/api/students/:studentId/photo',
  {
    preHandler: [killSwitchGuard, classLockGuard, rateLimiter],
  },
  async (request, reply) => {
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

    // B. Atomic Lock Database: Đổi từ 'empty'|'error'|'manual_review' -> 'pending'
    const claimed = await studentRepo.claimStudentForUpload(studentId, filePath);
    if (!claimed) {
      // Xóa file rác nếu claim thất bại (học sinh đã đăng ký hoặc đang pending)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Học sinh này đã được đăng ký hoặc đang trong quá trình xử lý.',
      });
    }

    // C. Tìm mã lớp của học sinh
    const classRecord = await classRepo.findById(claimed.class_id);
    const classCode = classRecord ? classRecord.code : 'UNKNOWN';

    // D. Đẩy job vào hàng đợi BullMQ (Idempotent JobID)
    const jobId = `student_${claimed.alias_id}`;
    const job = await registrationQueue.add(
      'register',
      {
        studentId: claimed.id,
        aliasId: claimed.alias_id,
        studentName: claimed.name,
        classCode,
        tempFilename: filename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER',
      },
      {
        jobId,
        removeOnComplete: true,
      }
    );

    // E. Ghi Audit Log
    await logRepo.recordLog({
      alias_id: claimed.alias_id,
      class_id: claimed.class_id,
      action: 'REGISTER',
      result_code: 'QUEUED',
      result_message: `Ảnh đã được lưu và đưa vào hàng đợi BullMQ (Job ID: ${job.id})`,
      ip: request.ip,
    });

    return reply.status(200).send({
      success: true,
      message: 'Nộp ảnh thành công! Yêu cầu đã vào hàng đợi xử lý.',
      jobId: job.id,
      student: claimed,
    });
  }
);

// 6. Endpoint Admin Cập nhật ảnh ưu tiên (Priority Job)
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

    const filename = `student_${student.alias_id}_override_${Date.now()}.jpg`;
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
        studentName: student.name,
        classCode: classRecord?.code || 'UNKNOWN',
        tempFilename: filename,
        uploadedAt: Date.now(),
        actionType: 'UPDATE_PHOTO',
        ...(student.person_id ? { personId: student.person_id } : {}),
      },
      {
        jobId: `student_${student.alias_id}_override_${Date.now()}`,
        priority: 1, // Admin priority job
        removeOnComplete: true,
      }
    );

    await logRepo.recordLog({
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

// 7. Yêu cầu hỗ trợ Admin từ học sinh (Rate limit: 5 lần/giờ/aliasId)
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

    const aliasId = fields.alias_id || fields.aliasId;
    if (!aliasId) {
      return reply.status(400).send({ message: 'Thiếu alias_id của học sinh.' });
    }

    // Rate Limit: 5 lần / giờ / alias_id
    const rateLimitKey = `ratelimit:admin_req:${aliasId}`;
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

    const filename = `admin_req_${aliasId}_${Date.now()}.jpg`;
    const filePath = path.join(UPLOAD_DIR, filename);

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      data.file.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    const studentRecord = await studentRepo.findByAliasId(aliasId);

    const created = await adminRequestRepo.createRequest({
      alias_id: aliasId,
      class_id: studentRecord ? studentRecord.class_id : undefined,
      student_name: fields.student_name || fields.studentName || (studentRecord ? studentRecord.name : undefined),
      image_path: filePath,
      note: fields.note || undefined,
      ip: request.ip,
    });

    await logRepo.recordLog({
      alias_id: aliasId,
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

// 8. API Health Check
server.get('/health', async (_request, reply) => {
  return reply.status(200).send({
    status: 'UP',
    timestamp: new Date().toISOString(),
    redis: redisClient.status,
  });
});

server.get('/api/health', async (_request, reply) => {
  return reply.status(200).send({
    status: 'UP',
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
