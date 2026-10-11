import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import pg from 'pg';
import dotenv from 'dotenv';
import { startMockHanet } from './mocks/hanet-mock-server.js';
import { handleFaceRegistration } from '../apps/worker/src/processors/register-face.processor.js';
import { validateStudentIdentifier } from '../shared/validators/identifier.validator.js';
import { REDIS_KEY_SYSTEM_REGISTRATION_DISABLED } from '../apps/worker/src/services/system-lock.service.js';

dotenv.config();

const { Pool } = pg;

describe('Hệ Thống Đăng Ký Học Sinh (Registration Test Suite)', () => {
  let redis: IORedis;
  let queue: Queue;
  let pool: pg.Pool;
  let mockServer: any;

  beforeAll(async () => {
    process.env.HANET_API_BASE_URL = 'http://localhost:9999';
    mockServer = await startMockHanet(9999);

    let redisUrl = process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@localhost:6379/0';
    redisUrl = redisUrl.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue('registration_queue', { connection: redis });

    let dbUrl = process.env.DATABASE_URL || 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
    dbUrl = dbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
    pool = new Pool({ connectionString: dbUrl });
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
    await pool.end();
    if (mockServer) {
      await mockServer.close();
    }
  });

  beforeEach(async () => {
    // Dọn dẹp cờ hệ thống trước mỗi test case
    await redis.del(REDIS_KEY_SYSTEM_REGISTRATION_DISABLED);
    await queue.resume();
  });

  // ==========================================
  // NHÓM 1: KIỂM THỬ ĐỊNH DẠNG 9 KÝ TỰ & CÔ LẬP
  // ==========================================
  describe('Tầng Kiểm Tra Định Dạng (Validator Engine)', () => {
    it('Phải chặn và cô lập mã seed cũ 17 ký tự (STU_...)', () => {
      const result = validateStudentIdentifier('STU_10A1_001_A7B2C', 'HANET_123');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('LEGACY_FORMAT_QUARANTINED');
      expect(result.isLockedForManualEdit).toBe(true);
    });

    it('Phải chấp nhận mã chuẩn 4_4 (9 ký tự)', () => {
      const result = validateStudentIdentifier('TS1A_A7B2', 'HANET_123');
      expect(result.isValid).toBe(true);
    });

    it('Phải từ chối mã không đủ độ dài hoặc sai regex (VD: TS1A_01)', () => {
      const result = validateStudentIdentifier('TS1A_01', 'HANET_123');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('INVALID_IDENTIFIER_FORMAT');
    });

    it('Phải chặn khi thiếu HANET person_id (Anchor Key)', () => {
      const result = validateStudentIdentifier('TS1A_A7B2', null);
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('MISSING_HANET_PERSON_ID');
    });
  });

  // ==========================================
  // NHÓM 2: KIỂM THỬ WORKER XỬ LÝ LỖI HANET
  // ==========================================
  describe('Tầng Worker & Ngoại Lệ HANET', () => {
    it('Case 0: Đăng ký thành công -> Ghi nhận person_id và status = synced', async () => {
      const mockJob = {
        id: 'job_success_01',
        data: {
          registrationId: 'reg_001',
          aliasId: 'TS1A_0023',
          name: 'Nguyễn Văn An',
          faceImageUrl: 'http://example.com/face.jpg',
        },
      } as any;

      const res = await handleFaceRegistration(mockJob);
      expect(res.success).toBe(true);
      expect(res.personId).toBeDefined();

      // Kiểm tra DB: Bản ghi phải có status = 'synced' và person_id
      const dbRes = await pool.query(
        "SELECT status, person_id FROM students WHERE alias_id = 'TS1A_0023'"
      );
      expect(dbRes.rows.length).toBeGreaterThan(0);
      expect(dbRes.rows[0].status).toBe('synced');
      expect(dbRes.rows[0].person_id).toBeDefined();
    });

    it('Case -9008 (Hết Quota): Ngắt hàng đợi, bật cờ khóa link đăng ký', async () => {
      const mockJob = {
        id: 'job_quota_exceeded',
        data: {
          registrationId: 'reg_002',
          aliasId: 'GLV0_0045',
          name: 'Trần Thị B',
          faceImageUrl: 'http://example.com/face.jpg',
          mockScenario: 'EXCEED_QUOTA', // Header điều khiển mock
        },
      } as any;

      await expect(handleFaceRegistration(mockJob)).rejects.toThrow(/Quota face exceeded/);

      // Kiểm tra cờ Redis đã bật để vô hiệu hóa form học sinh
      const isDisabled = await redis.get(REDIS_KEY_SYSTEM_REGISTRATION_DISABLED);
      expect(isDisabled).toBe('true');

      // Kiểm tra Queue đã bị pause
      const isPaused = await queue.isPaused();
      expect(isPaused).toBe(true);
    });

    it('Case -9005 (Xung đột): Khác alias_id -> Đưa vào danh sách duyệt thủ công', async () => {
      const mockJob = {
        id: 'job_conflict_01',
        data: {
          registrationId: 'reg_003',
          aliasId: 'TN02_1111',
          name: 'Lê Văn C',
          faceImageUrl: 'http://example.com/face.jpg',
          mockScenario: 'CONFLICT_DIFFERENT_PERSON',
        },
      } as any;

      await expect(handleFaceRegistration(mockJob)).rejects.toThrow(/Xung đột khuôn mặt/);

      // Kiểm tra DB: Bản ghi phải chuyển sang conflict_pending_review
      const res = await pool.query(
        "SELECT status FROM students WHERE alias_id = 'TN02_1111'"
      );
      if (res.rows.length > 0) {
        expect(res.rows[0].status).toBe('conflict_pending_review');
      }
    });
  });
});
