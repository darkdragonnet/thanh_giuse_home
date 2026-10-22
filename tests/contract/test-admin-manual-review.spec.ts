import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

function generateTestAlias(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TS1A_${suffix}`;
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
    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_T028_%'");
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_T028_%'");

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
    const aliasId = generateTestAlias();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, status, local_image_path)
       VALUES (2, $1, $2, 'pending', $3)
       RETURNING id, alias_id, name`,
      [`Test 9006 Student ${suffix}`, aliasId, testImagePath]
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
        classCode: '10A2',
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
    const aliasId = generateTestAlias();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, status, local_image_path)
       VALUES (2, $1, $2, 'pending', $3)
       RETURNING id, alias_id, name`,
      [`Test 103 Student ${suffix}`, aliasId, testImagePath]
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
        classCode: '10A2',
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
    const aliasId = generateTestAlias();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, status, local_image_path)
       VALUES (2, $1, $2, 'empty', $3)
       RETURNING id, alias_id, name, status`,
      [`Test Unlock Guard ${suffix}`, aliasId, testImagePath]
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
});
