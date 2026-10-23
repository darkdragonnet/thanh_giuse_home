import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue, UnrecoverableError } from 'bullmq';
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

const { Pool } = pg;
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

let testClassId: number;
let testClassCode: string;

function generateTestAlias(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${testClassCode}_${suffix}`;
}

describe('T026: Kill Switch -103 Protocol & Queue Auto-Recovery (US5-P0)', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let queue: Queue;
  let studentRepo: StudentRepository;
  let logRepo: LogRepository;
  let settingsRepo: SettingsRepository;
  let hanetClient: HanetClient;
  const createdStudentIds: number[] = [];
  const testImagePath = path.resolve('uploads/sample_t026_face.jpg');

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    const formattedRedisUrl = REDIS_URL.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redis = new IORedis(formattedRedisUrl, { maxRetriesPerRequest: null });
    queue = new Queue('registration_queue', { connection: redis });

    studentRepo = new StudentRepository(pool);
    logRepo = new LogRepository(pool);
    settingsRepo = new SettingsRepository(pool);

    const uniqueSuffix = Date.now().toString().slice(-2);
    testClassCode = `KS${uniqueSuffix}`;

    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test 103 ${testClassCode}`, `PIN_KS_${uniqueSuffix}`]
    );
    testClassId = clsRes.rows[0].id;

    hanetClient = new HanetClient({
      baseUrl: MOCK_API_BASE,
      token: 'mock_token',
      placeId: '998577',
      timeoutMs: 10_000,
    });

    // Chuẩn bị file ảnh mẫu trong thư mục uploads
    if (!fs.existsSync(path.resolve('uploads'))) {
      fs.mkdirSync(path.resolve('uploads'), { recursive: true });
    }
    const sampleSource = path.resolve('tests/fixtures/sample_face.jpg');
    fs.copyFileSync(sampleSource, testImagePath);
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu TEST_ dùng một lần
    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'KS%' OR alias_id LIKE 'TEST_T026_%'");
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'KS%' OR alias_id LIKE 'TEST_T026_%'");
    if (testClassId) {
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }

    // Xóa file ảnh mẫu test
    if (fs.existsSync(testImagePath)) {
      try {
        fs.unlinkSync(testImagePath);
      } catch {
        // ignore
      }
    }

    // Đảm bảo Kill Switch và queue được mở lại sau test
    await redis.del('system:registration_disabled');
    await redis.set('setting:kill_switch', 'false');
    await settingsRepo.setRegistrationEnabled(true);
    await queue.resume();

    await queue.close();
    await redis.quit();
    await closeDbPool(pool);
  });

  beforeEach(async () => {
    // Reset mock HANET
    await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
    await redis.del('system:registration_disabled');
    await redis.set('setting:kill_switch', 'false');
    await settingsRepo.setRegistrationEnabled(true);
    await queue.resume();
  });

  it('Mock -103: Kill Switch bị ngắt, job ném lỗi UnrecoverableError (không hoàn thành ảo), học sinh giữ pending -103, và mở lại Kill Switch tự động đưa học sinh vào queue', async () => {
    // 1. Tạo học sinh TEST_ ở trạng thái pending
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias();
    const qrToken = generateStudentQrToken();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, `Test 103 Student ${suffix}`, aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // 2. Cài đặt kịch bản Mock Server trả -103 (ACCESS_TOKEN_EXPIRE)
    await fetch(`${MOCK_API_BASE}/mock/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '-103', hits: 1 }),
    });

    let pauseWorkerCalled = false;
    const mockPauseWorker = async () => {
      pauseWorkerCalled = true;
      await queue.pause();
    };

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: path.basename(testImagePath),
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
    } as any;

    // 3. Thực thi processRegistrationJob: BẮT BUỘC phải ném lỗi UnrecoverableError (thất bại tường minh, không completed ảo)
    let threwError: any = null;
    try {
      await processRegistrationJob(mockJob, {
        studentRepo,
        logRepo,
        settingsRepo,
        redisClient: redis,
        hanetClient,
        pauseWorker: mockPauseWorker,
      });
    } catch (err: any) {
      threwError = err;
    }

    // Khẳng định 3a: Job KHÔNG kết thúc dạng "completed ảo", phải throw UnrecoverableError
    expect(threwError).toBeDefined();
    expect(threwError instanceof UnrecoverableError).toBe(true);

    // Khẳng định 3b: Kill Switch bị ngắt
    const killSwitchRedis = await redis.get('setting:kill_switch');
    expect(killSwitchRedis).toBe('true');

    const regEnabledDb = await settingsRepo.getSetting('registration_enabled');
    expect(regEnabledDb).toBe('false');

    expect(pauseWorkerCalled).toBe(true);

    // Khẳng định 3c: Học sinh VẪN pending kèm last_error_code = -103 (KHÔNG bị đưa sang manual_review)
    const studentInDb = await studentRepo.findById(testStudent.id);
    expect(studentInDb?.status).toBe('pending');
    expect(studentInDb?.last_error_code).toBe('-103');

    // 4. Mô phỏng Khôi phục: Bật lại Kill Switch qua POST /api/admin/settings/kill-switch { enabled: true }
    const unlockRes = await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ enabled: true }),
    });

    expect(unlockRes.status).toBe(200);
    const unlockBody: any = await unlockRes.json();
    expect(unlockBody.success).toBe(true);

    // Khẳng định 4a: Queue đã được resume
    const isPaused = await queue.isPaused();
    expect(isPaused).toBe(false);

    // Khẳng định 4b: Cờ Redis Kill Switch và system:registration_disabled đã được gỡ
    const killSwitchAfter = await redis.get('setting:kill_switch');
    expect(killSwitchAfter).toBe('false');
    const disabledFlag = await redis.get('system:registration_disabled');
    expect(disabledFlag).toBeFalsy();

    // Khẳng định 4c: Học sinh pending có last_error_code -103 đã được tự động quét đưa lại vào registrationQueue
    const requeuedJob = await queue.getJob(`student_${aliasId}`);
    expect(requeuedJob).toBeDefined();
    expect(requeuedJob?.data.studentId).toBe(testStudent.id);

    // Dọn dẹp job test trong queue
    if (requeuedJob) {
      await requeuedJob.remove();
    }
  });
});
