import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0';

describe('T017: Concurrency & Duplicate Registration Control (FR-004 & Principle III)', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let queue: Queue;
  let createdStudentIds: number[] = [];
  let testClassId: number;
  let testClassCode: string;
  let testTeacherPin: string;
  const jpegBuffer = fs.readFileSync(path.resolve('tests/fixtures/sample_face.jpg'));

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue('registration_queue', { connection: redis });

    const uniqueSuffix = Date.now().toString().slice(-4);
    testClassCode = `TC${uniqueSuffix}`;
    testTeacherPin = `PIN_CONC_${uniqueSuffix}`;

    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Concurrency ${testClassCode}`, testTeacherPin]
    );
    testClassId = clsRes.rows[0].id;
  });

  afterAll(async () => {
    // Dọn dẹp tuyệt đối mọi học sinh test dùng một lần (KHÔNG đụng vào dữ liệu thật)
    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_CONC_%'");
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_CONC_%'");
    if (testClassId) {
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }
    await queue.close();
    await redis.quit();
    await pool.end();
  });

  // Helper tạo học sinh test dùng một lần với trạng thái mong muốn
  async function createTestStudent(
    initialStatus: 'empty' | 'pending' | 'success' | 'error' | 'manual_review' = 'empty'
  ): Promise<{ id: number; alias_id: string; status: string }> {
    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const aliasId = `TEST_CONC_${uniqueSuffix}`;
    const name = `Test Student Conc ${uniqueSuffix}`;
    const qrToken = generateStudentQrToken();

    const res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, person_id, face_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, alias_id, status`,
      [
        testClassId,
        name,
        aliasId,
        qrToken,
        initialStatus,
        initialStatus === 'success' ? `PERSON_${uniqueSuffix}` : null,
        initialStatus === 'success' ? `https://example.com/face_${uniqueSuffix}.jpg` : null,
      ]
    );

    const student = res.rows[0];
    createdStudentIds.push(student.id);
    return student;
  }

  // Helper gửi photo upload request
  function sendPhotoUpload(
    studentId: number,
    options: {
      fakeIp?: string;
      teacherPin?: string;
    } = {}
  ) {
    const formData = new FormData();
    const blob = new Blob([jpegBuffer], { type: 'image/jpeg' });
    formData.append('photo', blob, 'sample_face.jpg');

    const headers: Record<string, string> = {
      'x-forwarded-for': options.fakeIp || `10.88.${Math.floor(Math.random() * 200)}.${studentId % 250}`,
    };
    if (options.teacherPin) {
      headers['x-teacher-pin'] = options.teacherPin;
    }

    return fetch(`${API_BASE}/api/students/${studentId}/photo`, {
      method: 'POST',
      headers,
      body: formData,
    });
  }

  // ===========================================================================
  // (a) ĐUA ĐỒNG THỜI (RACE CONDITION) - PROMISE.ALL
  // ===========================================================================
  it('(a) Đua đồng thời: Promise.all bắn 2 POST cùng lúc cho CÙNG 1 học sinh empty → đúng một 200, một 409 và đúng MỘT job', async () => {
    const student = await createTestStudent('empty');

    // Bắn 2 request song song đồng thời từ 2 IP khác nhau
    const [resA, resB] = await Promise.all([
      sendPhotoUpload(student.id, { fakeIp: '10.88.10.1' }),
      sendPhotoUpload(student.id, { fakeIp: '10.88.10.2' }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Request thành công phải trả về đúng jobId
    const successRes = resA.status === 200 ? resA : resB;
    const successBody: any = await successRes.json();
    expect(successBody.jobId).toBeTruthy();

    // Request thất bại phải nhận message Conflict 409
    const failedRes = resA.status === 409 ? resA : resB;
    const failedBody: any = await failedRes.json();
    expect(failedBody.error || failedBody.message).toMatch(/Conflict|đang trong quá trình xử lý/);

    // Kiểm tra DB: Học sinh phải ở trạng thái pending
    const dbRes = await pool.query('SELECT status FROM students WHERE id = $1', [student.id]);
    expect(dbRes.rows[0].status).toBe('pending');

    // Kiểm tra Audit Log: Đúng duy nhất MỘT lần enqueue thành công được ghi nhận
    const logRes = await pool.query(
      "SELECT result_code FROM logs WHERE alias_id = $1 AND result_code = 'QUEUED'",
      [student.alias_id]
    );
    expect(logRes.rows.length).toBe(1);

    // Kiểm tra hàng đợi BullMQ: Tối đa MỘT job (không bao giờ sinh 2 job trùng lặp)
    const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'delayed', 'failed']);
    const studentJobs = jobs.filter(
      (j) => j.data?.studentId === student.id || j.id?.includes(student.alias_id)
    );
    expect(studentJobs.length).toBeLessThanOrEqual(1);
  });

  // ===========================================================================
  // (b) MA TRẬN TUẦN TỰ (SEQUENTIAL MATRIX)
  // ===========================================================================
  describe('(b) Ma trận nộp lại tuần tự theo từng trạng thái học sinh', () => {
    it('1. Đang pending nộp lại → HTTP 409 Conflict', async () => {
      const student = await createTestStudent('pending');
      const res = await sendPhotoUpload(student.id);

      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body.message).toMatch(/đang trong quá trình xử lý|đã được đăng ký/);
    });

    it('2. Đã success tự nộp lại (không có PIN giáo viên) → HTTP 409 Conflict', async () => {
      const student = await createTestStudent('success');
      const res = await sendPhotoUpload(student.id);

      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body.message).toMatch(/đã được đăng ký|đang trong quá trình xử lý/);
    });

    it('3. Đang error nộp lại → HTTP 200 OK (chuyển sang pending)', async () => {
      const student = await createTestStudent('error');
      const res = await sendPhotoUpload(student.id);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);

      const dbRes = await pool.query('SELECT status FROM students WHERE id = $1', [student.id]);
      expect(dbRes.rows[0].status).toBe('pending');
    });

    it('4. Đang manual_review tự nộp lại → BẮT BUỘC nhận HTTP 409 Conflict (chỉ Admin mở khóa mới được nộp lại)', async () => {
      const student = await createTestStudent('manual_review');
      const res = await sendPhotoUpload(student.id);

      // Theo quy chuẩn FR-004 & Hiến pháp: manual_review KHÔNG được tự nộp lại, phải trả 409
      expect(res.status).toBe(409);

      // Trạng thái DB phải được bảo toàn là manual_review, không bị tự ý chuyển thành pending
      const dbRes = await pool.query('SELECT status FROM students WHERE id = $1', [student.id]);
      expect(dbRes.rows[0].status).toBe('manual_review');
    });
  });

  // ===========================================================================
  // (c) GIÁO VIÊN OVERRIDE BẰNG PIN HỢP LỆ
  // ===========================================================================
  it('(c) Giáo viên override bằng PIN hợp lệ cho học sinh success → được nhận HTTP 200 và job ưu tiên', async () => {
    const student = await createTestStudent('success');

    const res = await sendPhotoUpload(student.id, {
      teacherPin: testTeacherPin,
      fakeIp: '10.88.99.1',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/Cập nhật ảnh thành công|hàng đợi ưu tiên/);
  });
});
