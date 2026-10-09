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
} from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const server = Fastify({ logger: true });

// 1. Kết nối Database Pool
let dbUrl = process.env.DATABASE_URL || 'postgres://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
if (!fs.existsSync('/.dockerenv') && dbUrl.includes('@postgres:')) {
  dbUrl = dbUrl.replace('@postgres:', '@localhost:');
}

const pool = new Pool({
  connectionString: dbUrl,
});

export const studentRepo = new StudentRepository(pool);
export const classRepo = new ClassRepository(pool);
export const settingsRepo = new SettingsRepository(pool);
export const logRepo = new LogRepository(pool);

// Thư mục lưu ảnh upload
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 2. Đăng ký Plugins
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
});

// 3. API Lấy danh sách học sinh theo lớp
server.get<{ Params: { classId: string } }>('/api/classes/:classId/students', async (request, reply) => {
  const classId = parseInt(request.params.classId, 10);
  const students = await studentRepo.getStudentsByClassId(classId);
  return reply.send(students);
});

// 4. API Nộp ảnh với Atomic Conditional Lock
server.post<{ Params: { studentId: string } }>('/api/students/:studentId/photo', async (request, reply) => {
  const studentId = parseInt(request.params.studentId, 10);

  // A. Kiểm tra Global Kill Switch
  const isEnabled = await settingsRepo.isRegistrationEnabled();
  if (!isEnabled) {
    return reply.status(403).send({ message: 'Cổng đăng ký đang tạm đóng.' });
  }

  // B. Đọc file tải lên
  const data = await request.file();
  if (!data) {
    return reply.status(400).send({ message: 'Vui lòng chọn ảnh tải lên.' });
  }

  const filePath = path.join(UPLOAD_DIR, `student_${studentId}_${Date.now()}.jpg`);
  await new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    data.file.pipe(writeStream);
    writeStream.on('finish', () => resolve());
    writeStream.on('error', reject);
  });

  // C. Atomic Lock Database: Đổi từ 'empty' -> 'pending'
  const claimed = await studentRepo.claimStudentForUpload(studentId, filePath);
  if (!claimed) {
    // Xóa file rác nếu claim thất bại
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return reply.status(409).send({
      message: 'Học sinh này đã được đăng ký hoặc đang trong quá trình xử lý.',
    });
  }

  // Ghi Audit Log
  await logRepo.recordLog({
    alias_id: claimed.alias_id,
    class_id: claimed.class_id,
    action: 'REGISTER',
    result_code: 'QUEUED',
    result_message: 'Ảnh đã được lưu và khóa trạng thái pending',
    ip: request.ip,
  });

  return reply.status(200).send({
    success: true,
    message: 'Nộp ảnh thành công! Yêu cầu đã vào hàng đợi xử lý.',
    student: claimed,
  });
});

// Endpoint kiểm tra sức khỏe cơ bản
server.get('/api/health', async (_request, reply) => {
  return reply.status(200).send({ status: 'UP', timestamp: new Date().toISOString() });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

export async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`\n Server đang chạy tại: http://localhost:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
