import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { processRegistrationJob } from '../../apps/worker/src/processor.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const MOCK_API_BASE = process.env.HANET_MOCK_URL || 'http://localhost:4000';
const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0';
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'admin_secret_super_secure_token';

let testClassAId: number;
let testClassACode: string;
let testClassBId: number;
let testClassBCode: string;

function generateTestAlias(classCode: string = testClassACode): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${classCode}_${suffix}`;
}

describe('T028: Contract Test for Admin Manual Review & Unlock Guard (US5-P0)', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let queue: Queue;
  let studentRepo: StudentRepository;
  let logRepo: LogRepository;
  let settingsRepo: SettingsRepository;
  let hanetClient: HanetClient;
  const createdStudentIds: number[] = [];
  const testImagePath = path.resolve('uploads/sample_t028_face.jpg');

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    const formattedRedisUrl = REDIS_URL.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redis = new IORedis(formattedRedisUrl, { maxRetriesPerRequest: null });
    queue = new Queue('registration_queue', { connection: redis });

    studentRepo = new StudentRepository(pool);
    logRepo = new LogRepository(pool);
    settingsRepo = new SettingsRepository(pool);

    const uniqueSuffix = Date.now().toString().slice(-2);
    testClassACode = `MA${uniqueSuffix}`;
    testClassBCode = `MB${uniqueSuffix}`;

    const clsARes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassACode, `Lớp Test MR A ${testClassACode}`, `PIN_MRA_${uniqueSuffix}`]
    );
    testClassAId = clsARes.rows[0].id;

    const clsBRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassBCode, `Lớp Test MR B ${testClassBCode}`, `PIN_MRB_${uniqueSuffix}`]
    );
    testClassBId = clsBRes.rows[0].id;

    hanetClient = new HanetClient({
      baseUrl: MOCK_API_BASE,
      token: 'mock_token',
      placeId: '998577',
      timeoutMs: 10_000,
    });

    if (!fs.existsSync(path.resolve('uploads'))) {
      fs.mkdirSync(path.resolve('uploads'), { recursive: true });
    }
    const sampleSource = path.resolve('tests/fixtures/sample_face.jpg');
    fs.copyFileSync(sampleSource, testImagePath);
  });

  afterAll(async () => {
    try {
      await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ enabled: true }),
      });
    } catch {
      // ignore
    }

    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'MA%' OR alias_id LIKE 'MB%' OR action IN ('UNLOCK_STUDENT', 'UNLOCK', 'WEBHOOK_DEFERRED')");
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    if (testClassAId && testClassBId) {
      await pool.query('DELETE FROM students WHERE class_id = ANY($1::int[])', [[testClassAId, testClassBId]]);
      await pool.query('DELETE FROM classes WHERE id = ANY($1::int[])', [[testClassAId, testClassBId]]);
    }

    if (fs.existsSync(testImagePath)) {
      try {
        fs.unlinkSync(testImagePath);
      } catch {
        // ignore
      }
    }

    await queue.close();
    await redis.quit();
    await closeDbPool(pool);
  });

  beforeEach(async () => {
    await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
  });

  // (a) Mock -9006 -> học sinh vào manual_review
  it('(a) Mock -9006 (ảnh không đạt chuẩn): học sinh được cách ly sang manual_review', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias(testClassACode);
    const qrToken = generateStudentQrToken();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassAId, `Test 9006 Student ${suffix}`, aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    await fetch(`${MOCK_API_BASE}/mock/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '-9006', hits: 1 }),
    });

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassACode,
        tempFilename: path.basename(testImagePath),
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
    } as any;

    const res = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      hanetClient,
    });

    expect(res.quarantined).toBe(true);

    const studentInDb = await studentRepo.findById(testStudent.id);
    expect(studentInDb?.status).toBe('manual_review');
    expect(studentInDb?.last_error_code).toBe('-9006');
  });

  // (b) Học sinh lỗi token -103 sau khôi phục KHÔNG bị rơi oan vào manual_review
  it('(b) Học sinh lỗi token -103 sau khôi phục: KHÔNG bị rơi oan vào manual_review', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias(testClassACode);
    const qrToken = generateStudentQrToken();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassAId, `Test 103 Student ${suffix}`, aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // B1: Gặp lỗi -103
    await fetch(`${MOCK_API_BASE}/mock/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '-103', hits: 1 }),
    });

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassACode,
        tempFilename: path.basename(testImagePath),
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
    } as any;

    try {
      await processRegistrationJob(mockJob, {
        studentRepo,
        logRepo,
        settingsRepo,
        redisClient: redis,
        hanetClient,
      });
    } catch {
      // Expected throw
    }

    // Sau lỗi -103: học sinh PHẢI giữ pending, KHÔNG bị đẩy sang manual_review
    const studentAfter103 = await studentRepo.findById(testStudent.id);
    expect(studentAfter103?.status).toBe('pending');
    expect(studentAfter103?.status).not.toBe('manual_review');

    // B2: Khôi phục qua Kill Switch mở lại
    await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ enabled: true }),
    });

    // B3: Mock HANET trở lại hoạt động bình thường (thành công)
    await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });

    const successRes = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      redisClient: redis,
      hanetClient,
    });

    expect(successRes.success).toBe(true);

    const studentAfterRecovery = await studentRepo.findById(testStudent.id);
    expect(studentAfterRecovery?.status).toBe('success');
    expect(studentAfterRecovery?.status).not.toBe('manual_review');
  });

  // (c) POST /api/admin/students/:id/unlock trên học sinh KHÔNG ở trạng thái manual_review -> bị từ chối (4xx), không đổi trạng thái
  it('(c) POST /api/admin/students/:id/unlock trên học sinh KHÔNG ở manual_review: trả 4xx, không đổi trạng thái', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias(testClassACode);
    const qrToken = generateStudentQrToken();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'empty', $5)
       RETURNING id, alias_id, name, status`,
      [testClassAId, `Test Unlock Guard ${suffix}`, aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // Gọi unlock khi học sinh đang ở trạng thái 'empty'
    const res = await fetch(`${API_BASE}/api/admin/students/${testStudent.id}/unlock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
    });

    // Kỳ vọng HTTP 400 (hoặc 4xx) từ chối unlock hồ sơ không ở manual_review
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const body: any = await res.json();
    expect(body.message).toContain('manual_review');

    // Xác nhận trong DB: trạng thái học sinh vẫn là 'empty' không hề thay đổi
    const studentInDb = await studentRepo.findById(testStudent.id);
    expect(studentInDb?.status).toBe('empty');
  });

  // (d) GET /api/admin/students/manual-review: yêu cầu admin auth và chỉ trả học sinh manual_review đủ trường contract, hỗ trợ lọc theo lớp
  it('(d) GET /api/admin/students/manual-review: yêu cầu admin auth và chỉ trả học sinh manual_review đủ trường contract, hỗ trợ lọc theo lớp', async () => {
    // 1. Không có admin auth -> 401 hoặc 403
    const unauthRes = await fetch(`${API_BASE}/api/admin/students/manual-review`);
    expect([401, 403]).toContain(unauthRes.status);

    const invalidAuthRes = await fetch(`${API_BASE}/api/admin/students/manual-review`, {
      headers: { Authorization: 'Bearer invalid_secret_token' },
    });
    expect([401, 403]).toContain(invalidAuthRes.status);

    // 2. Chuẩn bị dữ liệu kiểm thử
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const alias1 = generateTestAlias(testClassACode);
    const alias2 = generateTestAlias(testClassACode);
    const alias3 = generateTestAlias(testClassBCode);
    const qr1 = generateStudentQrToken();
    const qr2 = generateStudentQrToken();
    const qr3 = generateStudentQrToken();

    // Học sinh 1: lớp A, manual_review
    const s1Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, last_error_code, last_error_message, retry_count)
       VALUES ($1, $2, $3, $4, 'manual_review', '-9006', 'Khuôn mặt mờ hoặc không đạt chuẩn', 1)
       RETURNING id, alias_id, name, status`,
      [testClassAId, `Test MR Student 1 ${suffix}`, alias1, qr1]
    );
    const s1 = s1Res.rows[0];
    createdStudentIds.push(s1.id);

    // Học sinh 2: lớp A, empty (không được xuất hiện trong manual-review)
    const s2Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status)
       VALUES ($1, $2, $3, $4, 'empty')
       RETURNING id, alias_id, name, status`,
      [testClassAId, `Test Non-MR Student 2 ${suffix}`, alias2, qr2]
    );
    const s2 = s2Res.rows[0];
    createdStudentIds.push(s2.id);

    // Học sinh 3: lớp B, manual_review
    const s3Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, last_error_code, last_error_message, retry_count)
       VALUES ($1, $2, $3, $4, 'manual_review', '-5011', 'Không tìm thấy personID', 3)
       RETURNING id, alias_id, name, status`,
      [testClassBId, `Test MR Student 3 ${suffix}`, alias3, qr3]
    );
    const s3 = s3Res.rows[0];
    createdStudentIds.push(s3.id);

    // 3. Có auth -> trả danh sách manual_review
    const res = await fetch(`${API_BASE}/api/admin/students/manual-review`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const list: any[] = await res.json();
    expect(Array.isArray(list)).toBe(true);

    // Học sinh 2 (status empty) tuyệt đối không có trong danh sách
    const foundS2 = list.find((item) => item.id === s2.id);
    expect(foundS2).toBeUndefined();

    // Học sinh 1 và 3 phải có trong danh sách
    const foundS1 = list.find((item) => item.id === s1.id);
    expect(foundS1).toBeDefined();
    expect(foundS1.alias_id).toBe(s1.alias_id);
    expect(foundS1.name).toBe(s1.name);
    expect(foundS1.status).toBe('manual_review');
    expect(foundS1.class_code).toBe(testClassACode);
    expect(foundS1.last_error_code).toBe('-9006');
    expect(foundS1.last_error_message).toBe('Khuôn mặt mờ hoặc không đạt chuẩn');
    expect(typeof foundS1.retry_count).toBe('number');
    expect(typeof foundS1.created_at).toBe('string');

    const foundS3 = list.find((item) => item.id === s3.id);
    expect(foundS3).toBeDefined();
    expect(foundS3.class_code).toBe(testClassBCode);

    // 4. Kiểm tra bộ lọc theo lớp
    const filteredRes = await fetch(`${API_BASE}/api/admin/students/manual-review?class_code=${testClassACode}`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    expect(filteredRes.status).toBe(200);
    const filteredList: any[] = await filteredRes.json();
    expect(Array.isArray(filteredList)).toBe(true);

    const filteredS1 = filteredList.find((item) => item.id === s1.id);
    const filteredS3 = filteredList.find((item) => item.id === s3.id);
    expect(filteredS1).toBeDefined();
    expect(filteredS3).toBeUndefined();
  });

  // (e) POST /api/admin/students/:id/unlock: mở khóa trọn contract với target_status và note
  it('(e) POST /api/admin/students/:id/unlock: mở khóa trọn contract với target_status và note, ghi audit log, trả đúng schema', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const alias1 = generateTestAlias(testClassACode);
    const alias2 = generateTestAlias(testClassACode);
    const qr1 = generateStudentQrToken();
    const qr2 = generateStudentQrToken();

    // 1. Tạo 2 học sinh manual_review
    const s1Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, last_error_code, last_error_message, retry_count, local_image_path)
       VALUES ($1, $2, $3, $4, 'manual_review', '-9006', 'Ảnh xấu', 2, $5)
       RETURNING id, alias_id, name, status`,
      [testClassAId, `Test Unlock Full ${suffix}`, alias1, qr1, testImagePath]
    );
    const s1 = s1Res.rows[0];
    createdStudentIds.push(s1.id);

    const s2Res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, last_error_code, last_error_message, retry_count, local_image_path)
       VALUES ($1, $2, $3, $4, 'manual_review', '-9006', 'Ảnh xấu', 2, $5)
       RETURNING id, alias_id, name, status`,
      [testClassAId, `Test Unlock Error ${suffix}`, alias2, qr2, testImagePath]
    );
    const s2 = s2Res.rows[0];
    createdStudentIds.push(s2.id);

    // 2. Mở khóa học sinh 1 về target_status: 'empty' kèm note
    const note1 = 'Đã xác nhận với GVCN cho phép học sinh chụp lại ảnh mới';
    const unlockRes1 = await fetch(`${API_BASE}/api/admin/students/${s1.id}/unlock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({
        target_status: 'empty',
        note: note1,
      }),
    });

    expect(unlockRes1.status).toBe(200);
    const body1: any = await unlockRes1.json();
    expect(body1.success).toBe(true);
    expect(body1.student_id).toBe(s1.id);
    expect(body1.previous_status).toBe('manual_review');
    expect(body1.current_status).toBe('empty');
    expect(typeof body1.message).toBe('string');

    // Kiểm tra DB học sinh 1
    const s1Db = await studentRepo.findById(s1.id);
    expect(s1Db?.status).toBe('empty');
    expect(s1Db?.last_error_code).toBeNull();
    expect(s1Db?.retry_count).toBe(0);

    // Kiểm tra dòng Audit Log trong bảng logs
    const auditLogs1 = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 ORDER BY id DESC LIMIT 1`,
      [s1.alias_id]
    );
    expect(auditLogs1.rows.length).toBeGreaterThan(0);
    const log1 = auditLogs1.rows[0];
    expect(log1.action).toMatch(/UNLOCK/i);
    expect(log1.result_message).toContain('manual_review');
    expect(log1.result_message).toContain('empty');
    expect(log1.result_message).toContain(note1);

    // 3. Mở khóa học sinh 2 về target_status: 'error'
    const note2 = 'Chuyển sang lỗi để liên hệ gia đình';
    const unlockRes2 = await fetch(`${API_BASE}/api/admin/students/${s2.id}/unlock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({
        target_status: 'error',
        note: note2,
      }),
    });

    expect(unlockRes2.status).toBe(200);
    const body2: any = await unlockRes2.json();
    expect(body2.success).toBe(true);
    expect(body2.student_id).toBe(s2.id);
    expect(body2.previous_status).toBe('manual_review');
    expect(body2.current_status).toBe('error');

    const s2Db = await studentRepo.findById(s2.id);
    expect(s2Db?.status).toBe('error');

    // 4. Kiểm tra validate target_status không hợp lệ
    const invalidTargetRes = await fetch(`${API_BASE}/api/admin/students/${s1.id}/unlock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({
        target_status: 'invalid_status_xyz',
      }),
    });
    expect([400, 422]).toContain(invalidTargetRes.status);
  });

  // (f) Webhook khi Kill Switch ngắt: trả 200 SUCCESS nhưng hoãn trạng thái học sinh và ghi log WEBHOOK_DEFERRED
  it('(f) Webhook khi Kill Switch ngắt: trả 200 SUCCESS nhưng hoãn trạng thái (không đổi) và ghi log WEBHOOK_DEFERRED; tắt Kill Switch -> áp dụng bình thường', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias(testClassACode);
    const qrToken = generateStudentQrToken();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status)
       VALUES ($1, $2, $3, $4, 'empty')
       RETURNING id, alias_id, name, status`,
      [testClassAId, `Test Webhook Student ${suffix}`, aliasId, qrToken]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    const clientSecret = process.env.HANET_CLIENT_SECRET || 'eb43ca63325ab6cfc71a38fc01511456';
    const makeHash = (id: string) => crypto.createHash('md5').update(clientSecret + id).digest('hex');

    try {
      // BƯỚC 1: BẬT KILL SWITCH (kích hoạt bảo trì / ngắt tiếp nhận)
      const pauseRes = await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ enabled: false }),
      });
      expect(pauseRes.status).toBe(200);

      // BƯỚC 2: GỬI WEBHOOK KHI KILL SWITCH ĐANG NGẮT
      const whId1 = `wh_pause_${Date.now()}`;
      const payload1 = {
        id: whId1,
        data_type: 'person',
        action_type: 'add',
        personID: `HANET_WH_${Date.now()}`,
        aliasID: aliasId,
        personName: testStudent.name,
        hash: makeHash(whId1),
      };

      const whRes1 = await fetch(`${API_BASE}/api/webhooks/hanet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload1),
      });

      // HTTP 200 OK để HANET không retry dồn dập
      expect(whRes1.status).toBe(200);
      const whBody1: any = await whRes1.json();
      expect(whBody1.returnCode).toBe(1);

      // Trạng thái học sinh trong DB TUYỆT ĐỐI KHÔNG ĐỔI (vẫn là empty)
      const studentAfterWh1 = await studentRepo.findById(testStudent.id);
      expect(studentAfterWh1?.status).toBe('empty');
      expect(studentAfterWh1?.person_id).toBeNull();

      // Có dòng log WEBHOOK_DEFERRED trong bảng logs
      const deferredLogs = await pool.query(
        `SELECT * FROM logs WHERE action = 'WEBHOOK_DEFERRED' AND (alias_id = $1 OR result_message LIKE $2) ORDER BY id DESC`,
        [aliasId, `%${aliasId}%`]
      );
      expect(deferredLogs.rows.length).toBeGreaterThan(0);
      expect(deferredLogs.rows[0].action).toBe('WEBHOOK_DEFERRED');

      // BƯỚC 3: TẮT KILL SWITCH (mở lại hệ thống)
      const resumeRes = await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ enabled: true }),
      });
      expect(resumeRes.status).toBe(200);

      // BƯỚC 4: GỬI WEBHOOK KHI KILL SWITCH ĐÃ MỞ LẠI -> HOẠT ĐỘNG BÌNH THƯỜNG
      const whId2 = `wh_resume_${Date.now()}`;
      const expectedPersonId = `HANET_WH_OK_${Date.now()}`;
      const payload2 = {
        id: whId2,
        data_type: 'person',
        action_type: 'add',
        personID: expectedPersonId,
        aliasID: aliasId,
        personName: testStudent.name,
        hash: makeHash(whId2),
      };

      const whRes2 = await fetch(`${API_BASE}/api/webhooks/hanet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload2),
      });
      expect(whRes2.status).toBe(200);

      // Trạng thái học sinh ĐÃ ĐƯỢC CẬP NHẬT thành success và gắn person_id
      const studentAfterWh2 = await studentRepo.findById(testStudent.id);
      expect(studentAfterWh2?.status).toBe('success');
      expect(studentAfterWh2?.person_id).toBe(expectedPersonId);
    } finally {
      // Đảm bảo Kill Switch luôn được bật lại sau test
      await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ enabled: true }),
      });
    }
  });
});
