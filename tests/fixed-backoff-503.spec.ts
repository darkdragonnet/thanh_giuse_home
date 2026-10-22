import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import {
  StudentRepository,
  LogRepository,
  createDbPool,
  closeDbPool,
} from '@thanh-giuse/shared-infra';
import { HanetClient } from '@thanh-giuse/hanet-client';
import {
  processRegistrationJob,
  HanetServiceUnavailableError,
} from '../apps/worker/src/processor.js';
import { createRegistrationQueue } from '../apps/api/src/queue.js';

const MOCK_API_BASE = process.env.HANET_MOCK_URL || 'http://localhost:4000';
const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0';

function generateTestAlias(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TS1A_${suffix}`;
}

describe('T027: Fixed Backoff 300s & 3-Tier Exhaustion to manual_review (US5-P0)', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let queue: Queue;
  let studentRepo: StudentRepository;
  let logRepo: LogRepository;
  let hanetClient: HanetClient;
  const createdStudentIds: number[] = [];
  const testImagePath = path.resolve('uploads/sample_t027_face.jpg');

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    const formattedRedisUrl = REDIS_URL.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redis = new IORedis(formattedRedisUrl, { maxRetriesPerRequest: null });
    queue = createRegistrationQueue(redis);

    studentRepo = new StudentRepository(pool);
    logRepo = new LogRepository(pool);

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
    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_T027_%'");
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_T027_%'");

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

  it('1. Cấu hình BullMQ Queue: backoff cố định 300_000 ms (5 phút) và attempts = 3', () => {
    const defaultJobOpts = queue.defaultJobOptions;
    expect(defaultJobOpts.attempts).toBe(3);
    expect(defaultJobOpts.backoff).toEqual({
      type: 'fixed',
      delay: 300_000,
    });
  });

  it('2. Lần thử 1 và 2: ném HanetServiceUnavailableError, học sinh giữ pending, retry_count tăng dần', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, status, local_image_path, retry_count)
       VALUES (2, $1, $2, 'pending', $3, 0)
       RETURNING id, alias_id, name`,
      [`Test 503 Student ${suffix}`, aliasId, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // Cài mock HANET trả -503
    await fetch(`${MOCK_API_BASE}/mock/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '-503', hits: 2 }),
    });

    const mockJob = {
      id: `student_${aliasId}`,
      opts: { attempts: 3 },
      attemptsMade: 0,
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

    // Lần thử 1
    await expect(
      processRegistrationJob(mockJob, {
        studentRepo,
        logRepo,
        hanetClient,
      })
    ).rejects.toThrow(HanetServiceUnavailableError);

    let studentAfterAttempt1 = await studentRepo.findById(testStudent.id);
    expect(studentAfterAttempt1?.status).toBe('pending');
    expect(studentAfterAttempt1?.retry_count).toBe(1);
    expect(studentAfterAttempt1?.last_error_code).toBe('-503');

    // Lần thử 2
    mockJob.attemptsMade = 1;
    await expect(
      processRegistrationJob(mockJob, {
        studentRepo,
        logRepo,
        hanetClient,
      })
    ).rejects.toThrow(HanetServiceUnavailableError);

    let studentAfterAttempt2 = await studentRepo.findById(testStudent.id);
    expect(studentAfterAttempt2?.status).toBe('pending');
    expect(studentAfterAttempt2?.retry_count).toBe(2);
    expect(studentAfterAttempt2?.last_error_code).toBe('-503');
  });

  it('3. Lần thử 3 (chạm trần 3 lần) qua đường processor: chuyển manual_review kèm last_error_code -503', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, status, local_image_path, retry_count)
       VALUES (2, $1, $2, 'pending', $3, 2)
       RETURNING id, alias_id, name`,
      [`Test 503 MaxRetries ${suffix}`, aliasId, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    await fetch(`${MOCK_API_BASE}/mock/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: '-503', hits: 1 }),
    });

    const mockJob = {
      id: `student_${aliasId}`,
      opts: { attempts: 3 },
      attemptsMade: 2,
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

    const result = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      hanetClient,
    });

    expect(result.quarantined).toBe(true);

    const studentAfterAttempt3 = await studentRepo.findById(testStudent.id);
    expect(studentAfterAttempt3?.status).toBe('manual_review');
    expect(studentAfterAttempt3?.last_error_code).toBe('-503');
  });

  it('4. Kiểm tra đường listener worker.on("failed"): khi job cạn attempts, cập nhật DB sang manual_review', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const aliasId = generateTestAlias();
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, status, local_image_path, retry_count, last_error_code)
       VALUES (2, $1, $2, 'pending', $3, 2, '-503')
       RETURNING id, alias_id, name`,
      [`Test 503 WorkerListener ${suffix}`, aliasId, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // Giả lập worker handler cho sự kiện 'failed'
    const { handleWorkerFailed } = await import('../apps/worker/src/worker.js').catch(() => ({
      handleWorkerFailed: null,
    }));

    // Import hoặc kích hoạt logic listener
    const mockFailedJob = {
      id: `student_${aliasId}`,
      opts: { attempts: 3 },
      attemptsMade: 3,
      data: {
        studentId: testStudent.id,
        aliasId,
      },
      failedReason: 'Hệ thống nhận diện đang quá tải (-503)',
    } as any;

    if (typeof handleWorkerFailed === 'function') {
      await handleWorkerFailed(mockFailedJob, new Error('HANET_SERVICE_UNAVAILABLE'));
      const studentAfterListener = await studentRepo.findById(testStudent.id);
      expect(studentAfterListener?.status).toBe('manual_review');
      expect(studentAfterListener?.last_error_code).toBe('-503');
    } else {
      // Nếu worker.ts export worker, ta giả lập emit sự kiện failed
      const { registrationWorker } = await import('../apps/worker/src/worker.js');
      registrationWorker.emit('failed', mockFailedJob, new Error('HANET_SERVICE_UNAVAILABLE'));
      // Đợi một khoảng ngắn cho listener async hoàn thành
      await new Promise((r) => setTimeout(r, 200));

      const studentAfterListener = await studentRepo.findById(testStudent.id);
      expect(studentAfterListener?.status).toBe('manual_review');
    }
  });
});
