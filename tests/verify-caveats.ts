import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  StudentRepository,
  LogRepository,
  createDbPool,
  closeDbPool,
  createRedisClient,
  closeRedisClient,
} from '@thanh-giuse/shared-infra';
import { HanetClient } from '@thanh-giuse/hanet-client';
import { processRegistrationJob } from '../apps/worker/src/processor.js';

const API_BASE = 'http://localhost:3000';
const MOCK_API_BASE = 'http://localhost:4000';
const dbUrl = 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const redisUrl = 'redis://:super_secure_redis_password_change_me@localhost:6379/0';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  KIỂM TRA CHÉO 3 ĐIỂM LƯU Ý THỰC TẾ (PRACTICAL CAVEATS)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const pool = createDbPool({ connectionString: dbUrl });
  const redis = createRedisClient({ url: redisUrl });
  const studentRepo = new StudentRepository(pool);
  const logRepo = new LogRepository(pool);

  const hanetClient = new HanetClient({
    baseUrl: MOCK_API_BASE,
    token: 'mock_token',
    placeId: '196',
    timeoutMs: 10_000,
  });

  const uploadDir = path.resolve('uploads');
  const tmpFacesDir = path.join(uploadDir, 'tmp-faces');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  if (!fs.existsSync(tmpFacesDir)) fs.mkdirSync(tmpFacesDir, { recursive: true });

  const sampleOriginalImage = path.join(uploadDir, 'caveat_test_original.jpg');
  await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 120, g: 200, b: 80 },
    },
  })
    .jpeg()
    .toFile(sampleOriginalImage);

  // ---------------------------------------------------------------------------
  // 1. KIỂM TRA DỌN DẸP FILE TẠM uploads/tmp-faces/ SAU KHI THÀNH CÔNG
  // ---------------------------------------------------------------------------
  console.log('[CAVEAT 1] Kiểm tra giải phóng file tạm trong uploads/tmp-faces/:');
  await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });

  await pool.query(
    "UPDATE students SET status = 'pending', local_image_path = $1 WHERE id = 1",
    [sampleOriginalImage]
  );

  // Dọn sạch thư mục tmp-faces trước khi test
  for (const f of fs.readdirSync(tmpFacesDir)) {
    fs.unlinkSync(path.join(tmpFacesDir, f));
  }

  const successJob = {
    id: 'job_caveat_cleanup',
    attemptsMade: 1,
    data: {
      studentId: 1,
      aliasId: 'STU_10A1_001_A7B2C',
      studentName: 'Nguyễn Hoàng Long',
      classCode: '10A1',
      tempFilename: 'caveat_test_original.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  const resSuccess = await processRegistrationJob(successJob, {
    studentRepo,
    logRepo,
    hanetClient,
  });

  console.log('- Kết quả đăng ký:', resSuccess);
  if (!resSuccess.success) throw new Error('Đăng ký không thành công ở Caveat 1');

  // Đợi 200ms để tác vụ xóa bất đồng bộ hoàn tất
  await sleep(200);

  // Kiểm tra file tạm trong tmp-faces đã được xóa chưa
  const tmpFiles = fs.readdirSync(tmpFacesDir);
  console.log('- Danh sách file còn lại trong uploads/tmp-faces/:', tmpFiles);

  if (tmpFiles.length > 0) {
    throw new Error(`Caveat 1 Thất bại: Vẫn còn file tạm trong tmp-faces: ${tmpFiles.join(', ')}`);
  }
  console.log('-> File tạm trong tmp-faces/ đã được xóa thành công ngay sau khi có kết quả!');

  // Kiểm tra file ảnh gốc vẫn được bảo toàn
  if (!fs.existsSync(sampleOriginalImage)) {
    throw new Error('Caveat 1 Thất bại: File ảnh gốc bị xóa nhầm!');
  }
  console.log('-> File ảnh gốc ban đầu tại uploads/ được bảo toàn nguyên vẹn.');
  console.log('-> PASS [CAVEAT 1]: Dọn dẹp an toàn chống tràn 20GB SSD thành công!\n');

  // ---------------------------------------------------------------------------
  // 2. KIỂM TRA CHUẨN HÓA NHẬN DIỆN IP MÁY KHÁCH QUA NGINX (x-forwarded-for)
  // ---------------------------------------------------------------------------
  console.log('[CAVEAT 2] Kiểm tra Rate Limiter đọc IP thực từ x-forwarded-for:');
  const simulatedClientIp = '203.113.1.5';
  const redisKey = `ratelimit:ip:${simulatedClientIp}`;
  await redis.del(redisKey);

  // Tạo dummy image buffer
  const dummyBuffer = Buffer.alloc(1024, 0xee);

  // Gửi 5 request với header x-forwarded-for: 203.113.1.5
  for (let i = 1; i <= 5; i++) {
    const formData = new FormData();
    formData.append('photo', new Blob([dummyBuffer], { type: 'image/jpeg' }), 'ip_test.jpg');

    const res = await fetch(`${API_BASE}/api/students/2/photo`, {
      method: 'POST',
      body: formData,
      headers: {
        'x-forwarded-for': `${simulatedClientIp}, 172.18.0.2`,
      },
    });
    console.log(`- Request #${i} từ IP ${simulatedClientIp}: HTTP ${res.status}`);
  }

  // Kiểm tra Redis ZSET có ghi nhận đúng key IP khách không
  const zcard = await redis.zcard(redisKey);
  console.log(`- Số lượng request ghi nhận trong Redis key "${redisKey}":`, zcard);
  if (zcard !== 5) {
    throw new Error(`Caveat 2 Thất bại: Redis key ${redisKey} có ${zcard} request thay vì 5`);
  }

  // Gửi request thứ 6 từ cùng IP đó -> PHẢI nhận HTTP 429
  const formData6 = new FormData();
  formData6.append('photo', new Blob([dummyBuffer], { type: 'image/jpeg' }), 'ip_test.jpg');
  const res6 = await fetch(`${API_BASE}/api/students/2/photo`, {
    method: 'POST',
    body: formData6,
    headers: {
      'x-forwarded-for': `${simulatedClientIp}, 172.18.0.2`,
    },
  });
  console.log(`- Request #6 (Mong đợi 429) từ IP ${simulatedClientIp}: HTTP ${res6.status}`);
  if (res6.status !== 429) {
    throw new Error(`Caveat 2 Thất bại: Mong đợi HTTP 429, nhận được ${res6.status}`);
  }
  console.log('-> PASS [CAVEAT 2]: Rate Limiter đã nhận diện chuẩn xác IP máy khách thực tế qua chuỗi proxy!\n');

  // ---------------------------------------------------------------------------
  // 3. KIỂM TRA MỨC CẢNH BÁO CRITICAL & ACTION 'QUOTA_EXCEEDED' KHI GẶP LỖI -9008
  // ---------------------------------------------------------------------------
  console.log('[CAVEAT 3] Kiểm tra Log CRITICAL và action QUOTA_EXCEEDED khi gặp lỗi -9008:');
  await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
  await fetch(`${MOCK_API_BASE}/mock/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: '-9008', hits: 1 }),
  });

  await pool.query(
    "UPDATE students SET status = 'pending', local_image_path = $1 WHERE id = 5",
    [sampleOriginalImage]
  );

  let pauseCalled = false;
  const job9008 = {
    id: 'job_caveat_9008',
    attemptsMade: 1,
    data: {
      studentId: 5,
      aliasId: 'STU_10A2_002_N3P4Q',
      studentName: 'Vũ Mai Phương',
      classCode: '10A2',
      tempFilename: 'caveat_test_original.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  const res9008 = await processRegistrationJob(job9008, {
    studentRepo,
    logRepo,
    hanetClient,
    pauseWorker: async () => {
      pauseCalled = true;
    },
  });

  console.log('- Kết quả xử lý lỗi -9008:', res9008);
  if (!pauseCalled) {
    throw new Error('Caveat 3 Thất bại: pauseWorker không được gọi khi gặp lỗi -9008');
  }

  // Kiểm tra Audit Log có action = 'QUOTA_EXCEEDED' và result_code = 'CRITICAL_QUOTA_EXCEEDED'
  const logRow = await pool.query(
    "SELECT action, result_code, result_message FROM logs WHERE alias_id = 'STU_10A2_002_N3P4Q' AND action = 'QUOTA_EXCEEDED' ORDER BY id DESC LIMIT 1"
  );

  if (logRow.rows.length === 0) {
    throw new Error('Caveat 3 Thất bại: Không tìm thấy log với action="QUOTA_EXCEEDED"');
  }

  const logData = logRow.rows[0];
  console.log('- Bản ghi Audit Log:', logData);
  if (logData.action !== 'QUOTA_EXCEEDED' || logData.result_code !== 'CRITICAL_QUOTA_EXCEEDED') {
    throw new Error(`Caveat 3 Thất bại: Log không đúng action hoặc result_code: ${JSON.stringify(logData)}`);
  }

  const student5 = await studentRepo.findById(5);
  if (student5?.status !== 'manual_review') {
    throw new Error(`Caveat 3 Thất bại: Student không chuyển sang manual_review. Hiện tại: ${student5?.status}`);
  }

  console.log('-> PASS [CAVEAT 3]: Log CRITICAL, action="QUOTA_EXCEEDED" và chuyển manual_review thành công!\n');

  // Cleanup
  if (fs.existsSync(sampleOriginalImage)) fs.unlinkSync(sampleOriginalImage);
  await redis.del(redisKey);
  await closeRedisClient(redis);
  await closeDbPool(pool);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🎉 TOÀN BỘ 3 ĐIỂM LƯU Ý THỰC TẾ ĐỀU PASS 100%!');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('LỖI TEST CAVEATS:', err);
  process.exit(1);
});
