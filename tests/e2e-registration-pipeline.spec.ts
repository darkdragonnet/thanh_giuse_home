import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import {
  StudentRepository,
  LogRepository,
  SettingsRepository,
  createDbPool,
  closeDbPool,
  generateStudentQrToken,
} from '@thanh-giuse/shared-infra';
import { HanetClient } from '@thanh-giuse/hanet-client';
import { processRegistrationJob } from '../apps/worker/src/processor.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const MOCK_API_BASE = process.env.HANET_MOCK_URL || 'http://localhost:4000';
const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
const REDIS_URL = (
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0'
).replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'admin_secret_super_secure_token';

// Bất biến P0 Security: Danh sách 10 trường nhạy cảm BỊ CẤM trong payload danh sách lớp công khai
const FORBIDDEN_PUBLIC_ROSTER_FIELDS = [
  'qr_token',
  'face_url',
  'local_image_path',
  'person_id',
  'last_error_code',
  'last_error_message',
  'normalized_name',
  'cloud_alias_synced',
  'is_updating',
  'retry_count',
];

// Bất biến bảo mật cho endpoint tra cứu trạng thái học sinh (không làm lộ person_id hoặc face_url)
const FORBIDDEN_STATUS_FIELDS = [
  'qr_token',
  'face_url',
  'local_image_path',
  'person_id',
  'normalized_name',
  'cloud_alias_synced',
];

// Hàm sinh Alias ID chuẩn 9 ký tự ^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$ (Cloud Ceiling Guard)
function generateTestAlias(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TS1A_${suffix}`;
}

describe('T033: End-to-End Registration Pipeline against Mock HANET (Phase 8)', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let queue: Queue;
  let studentRepo: StudentRepository;
  let logRepo: LogRepository;
  let settingsRepo: SettingsRepository;
  let mockHanetClient: HanetClient;

  let testClassId: number;
  const uniqueRun = Date.now().toString().slice(-6);
  const testClassCode = `TC_E2E_${uniqueRun}`;
  const teacherPin = `PIN_E2E_${uniqueRun}`;

  let student1Id: number;
  const student1Alias = generateTestAlias();
  const student1Name = `TEST_ E2E Success Student ${uniqueRun}`;

  let student2Id: number;
  const student2Alias = generateTestAlias();
  const student2Name = `TEST_ E2E Error Student ${uniqueRun}`;

  const fixtureSamplePath = path.resolve('tests/fixtures/sample_face.jpg');
  const uploadsDir = path.resolve('uploads');

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue('registration_queue', { connection: redis });

    studentRepo = new StudentRepository(pool);
    logRepo = new LogRepository(pool);
    settingsRepo = new SettingsRepository(pool);

    mockHanetClient = new HanetClient({
      baseUrl: MOCK_API_BASE,
      token: 'mock_token',
      placeId: '998577',
      timeoutMs: 10_000,
    });

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Tạm dừng queue để worker nền không tranh chấp job test
    await queue.pause();

    // Reset Mock HANET về trạng thái baseline
    await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });

    // 1. Tạo lớp học test dùng-một-lần
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp E2E Test ${testClassCode}`, teacherPin]
    );
    testClassId = clsRes.rows[0].id;

    // 2. Tạo 2 học sinh test dùng-một-lần ở trạng thái 'empty'
    const s1Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status)
       VALUES ($1, $2, $3, $4, 'empty')
       RETURNING id`,
      [testClassId, student1Name, student1Alias, generateStudentQrToken()]
    );
    student1Id = s1Res.rows[0].id;

    const s2Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status)
       VALUES ($1, $2, $3, $4, 'empty')
       RETURNING id`,
      [testClassId, student2Name, student2Alias, generateStudentQrToken()]
    );
    student2Id = s2Res.rows[0].id;
  });

  afterAll(async () => {
    // 1. Phục hồi trạng thái queue
    try {
      await queue.resume();
    } catch {
      // ignore
    }

    // 2. Dọn dẹp Mock HANET
    try {
      await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
    } catch {
      // ignore
    }

    // 3. Xóa dữ liệu TEST_ dùng-một-lần trong DB
    if (testClassId) {
      await pool.query('DELETE FROM logs WHERE class_id = $1 OR alias_id = ANY($2::text[])', [
        testClassId,
        [student1Alias, student2Alias],
      ]);
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }

    // 4. Dọn dẹp tệp ảnh test đã tải lên
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        if (file.includes(student1Alias) || file.includes(student2Alias) || file.includes(uniqueRun)) {
          try {
            fs.unlinkSync(path.join(uploadsDir, file));
          } catch {
            // ignore
          }
        }
      }
    }

    await queue.close();
    await redis.quit();
    await closeDbPool(pool);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHUỖI 1: HAPPY PATH TRỌN VẸN MỘT HỌC SINH TỚI SUCCESS & BẢO VỆ BẤT BIẾN P0
  // ═══════════════════════════════════════════════════════════════════════════
  it('Chuỗi 1: Nộp ảnh hợp lệ -> Tiếp nhận pending -> Worker đồng bộ mock HANET -> Status success -> DTO công khai tối thiểu', async () => {
    // Bước A: Nộp ảnh qua API (POST /api/students/:id/photo)
    const imageBytes = fs.readFileSync(fixtureSamplePath);
    const formData = new FormData();
    formData.append('photo', new Blob([imageBytes], { type: 'image/jpeg' }), 'face.jpg');

    const t0 = Date.now();
    const uploadRes = await fetch(`${API_BASE}/api/students/${student1Id}/photo`, {
      method: 'POST',
      body: formData,
    });
    const uploadElapsed = Date.now() - t0;

    expect(uploadElapsed).toBeLessThan(1500);
    expect(uploadRes.status).toBe(200);

    const uploadBody: any = await uploadRes.json();
    expect(uploadBody.success).toBe(true);

    // Xác nhận trong CSDL: trạng thái học sinh đã chuyển sang 'pending'
    const student1Pending = await studentRepo.findById(student1Id);
    expect(student1Pending).toBeDefined();
    expect(student1Pending?.status).toBe('pending');
    expect(student1Pending?.local_image_path).toBeTruthy();

    // Bước B: Kiểm tra endpoint trạng thái khi đang pending (GET /api/students/:id/status)
    const statusPendingRes = await fetch(`${API_BASE}/api/students/${student1Id}/status`);
    expect(statusPendingRes.status).toBe(200);
    const statusPendingBody: any = await statusPendingRes.json();
    expect(statusPendingBody.status).toBe('pending');
    expect(typeof statusPendingBody.queue_position).toBe('number');
    expect(statusPendingBody.queue_position).toBeGreaterThanOrEqual(1);
    expect(typeof statusPendingBody.estimated_wait_minutes).toBe('number');

    // Khẳng định không rò rỉ trường nhạy cảm trong status endpoint
    for (const forbidden of FORBIDDEN_STATUS_FIELDS) {
      expect(statusPendingBody).not.toHaveProperty(forbidden);
    }

    // Bước C: Worker xử lý job qua Mock HANET (Happy path 200)
    const jobId = `student_${student1Alias}`;
    const bullJob = await queue.getJob(jobId);
    expect(bullJob).toBeDefined();

    // Đồng bộ file trên môi trường runner nếu chạy ngoài Docker container
    const hostImagePath = path.join(uploadsDir, bullJob!.data.tempFilename);
    if (!fs.existsSync(hostImagePath)) {
      fs.copyFileSync(fixtureSamplePath, hostImagePath);
    }

    const workerResult = await processRegistrationJob(bullJob!, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanetClient,
      redisClient: redis,
    });

    expect(workerResult.success).toBe(true);
    expect(workerResult.personId).toBeTruthy();

    // Xóa job khỏi hàng đợi test
    await bullJob!.remove();

    // Xác nhận trạng thái CSDL đã cập nhật thành công (success)
    const student1Success = await studentRepo.findById(student1Id);
    expect(student1Success?.status).toBe('success');
    expect(student1Success?.person_id).toBeTruthy();
    expect(student1Success?.face_url).toBeTruthy();

    // Bước D: Endpoint trạng thái phản ánh tiến trình tới success
    const statusSuccessRes = await fetch(`${API_BASE}/api/students/${student1Id}/status`);
    expect(statusSuccessRes.status).toBe(200);
    const statusSuccessBody: any = await statusSuccessRes.json();
    expect(statusSuccessBody.status).toBe('success');
    expect(statusSuccessBody.queue_position).toBeNull();
    expect(statusSuccessBody.estimated_wait_minutes).toBeNull();

    for (const forbidden of FORBIDDEN_STATUS_FIELDS) {
      expect(statusSuccessBody).not.toHaveProperty(forbidden);
    }

    // Bước E: Danh sách lớp công khai chỉ chứa DTO tối thiểu (Khẳng định lại các bất biến P0)
    const rosterRes = await fetch(`${API_BASE}/api/classes/${testClassCode}/students`);
    expect(rosterRes.status).toBe(200);
    expect(rosterRes.headers.get('x-teacher-verified')).toBe('false');

    const rosterList: any[] = await rosterRes.json();
    expect(Array.isArray(rosterList)).toBe(true);

    const s1Public = rosterList.find((s) => s.id === student1Id);
    expect(s1Public).toBeDefined();
    expect(s1Public.id).toBe(student1Id);
    expect(s1Public.name).toBe(student1Name);
    expect(s1Public.alias_id).toBe(student1Success?.alias_id);
    expect(s1Public.status).toBe('success');

    // Khẳng định tuyệt đối 10 trường nhạy cảm không xuất hiện trong public roster
    for (const field of FORBIDDEN_PUBLIC_ROSTER_FIELDS) {
      expect(s1Public).not.toHaveProperty(field);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHUỖI 2: NHÁNH LỖI ĐẦU-CUỐI (MOCK -9006 -> MANUAL_REVIEW -> ADMIN REVIEW)
  // ═══════════════════════════════════════════════════════════════════════════
  it('Chuỗi 2: Nhánh lỗi đầu-cuối: Nộp ảnh -> Gặp mock -9006 -> Chuyển manual_review -> Xuất hiện trên Admin manual-review', async () => {
    // Bước A: Kích hoạt kịch bản giả lập -9006 trên Mock HANET (Ảnh mờ / AI không nhận diện được mặt)
    await fetch(`${MOCK_API_BASE}/mock/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '-9006', hits: 1 }),
    });

    // Bước B: Nộp ảnh cho học sinh thứ 2 qua API
    const imageBytes = fs.readFileSync(fixtureSamplePath);
    const formData = new FormData();
    formData.append('photo', new Blob([imageBytes], { type: 'image/jpeg' }), 'face2.jpg');

    const uploadRes = await fetch(`${API_BASE}/api/students/${student2Id}/photo`, {
      method: 'POST',
      body: formData,
    });
    expect(uploadRes.status).toBe(200);

    const student2Pending = await studentRepo.findById(student2Id);
    expect(student2Pending?.status).toBe('pending');

    // Bước C: Worker xử lý job, gặp lỗi -9006 và thực hiện Fast Isolation
    const jobId2 = `student_${student2Alias}`;
    const bullJob2 = await queue.getJob(jobId2);
    expect(bullJob2).toBeDefined();

    const hostImagePath2 = path.join(uploadsDir, bullJob2!.data.tempFilename);
    if (!fs.existsSync(hostImagePath2)) {
      fs.copyFileSync(fixtureSamplePath, hostImagePath2);
    }

    const workerResult2 = await processRegistrationJob(bullJob2!, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanetClient,
      redisClient: redis,
    });

    expect(workerResult2.quarantined).toBe(true);
    await bullJob2!.remove();

    // Bước D: Xác nhận học sinh 2 đã chuyển trạng thái manual_review với mã lỗi -9006
    const student2Quarantined = await studentRepo.findById(student2Id);
    expect(student2Quarantined?.status).toBe('manual_review');
    expect(student2Quarantined?.last_error_code).toBe('-9006');

    // Endpoint trạng thái phản ánh học sinh đang ở manual_review
    const statusMrRes = await fetch(`${API_BASE}/api/students/${student2Id}/status`);
    expect(statusMrRes.status).toBe(200);
    const statusMrBody: any = await statusMrRes.json();
    expect(statusMrBody.status).toBe('manual_review');

    // Bước E: Xuất hiện qua GET /api/admin/students/manual-review của Admin
    const adminRes = await fetch(`${API_BASE}/api/admin/students/manual-review?class_code=${testClassCode}`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    expect(adminRes.status).toBe(200);

    const adminReviewList: any[] = await adminRes.json();
    expect(Array.isArray(adminReviewList)).toBe(true);

    const s2InAdmin = adminReviewList.find((s) => s.id === student2Id);
    expect(s2InAdmin).toBeDefined();
    expect(s2InAdmin.name).toBe(student2Name);
    expect(s2InAdmin.alias_id).toBe(student2Alias);
    expect(s2InAdmin.status).toBe('manual_review');
    expect(s2InAdmin.last_error_code).toBe('-9006');
    expect(s2InAdmin.class_code).toBe(testClassCode);
  });
});
