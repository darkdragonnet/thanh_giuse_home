import fs from 'node:fs';
import path from 'node:path';
import {
  StudentRepository,
  ClassRepository,
  SettingsRepository,
  createDbPool,
  closeDbPool,
  createRedisClient,
  closeRedisClient,
} from '@thanh-giuse/shared-infra';

const API_BASE = 'http://localhost:3000';
const dbUrl = 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const redisUrl = 'redis://:super_secure_redis_password_change_me@localhost:6379/0';

async function main() {
  console.log('--- KHỞI ĐỘNG KIỂM CHỨNG PHASE 1 & PHASE 2 ---');

  const pool = createDbPool({ connectionString: dbUrl });
  const redis = createRedisClient({ url: redisUrl });
  const studentRepo = new StudentRepository(pool);
  const classRepo = new ClassRepository(pool);
  const settingsRepo = new SettingsRepository(pool);

  // 1. Dọn dẹp rate limit key thử nghiệm
  await redis.del('ratelimit:ip:127.0.0.1');

  // Lấy danh sách lớp và học sinh
  const classRecord = await classRepo.findByCode('10A1');
  if (!classRecord) throw new Error('Không tìm thấy lớp 10A1');

  // Đảm bảo lớp không bị khóa ban đầu
  await classRepo.setClassLock(classRecord.id, false);
  await settingsRepo.setRegistrationEnabled(true);

  // Reset học sinh id=2 sang 'empty' để nộp ảnh
  await pool.query("UPDATE students SET status = 'empty', local_image_path = NULL WHERE id = 2");

  // Tạo dummy image buffer
  const dummyBuffer = Buffer.alloc(1024, 0xff);

  function createFormData(): FormData {
    const formData = new FormData();
    const blob = new Blob([dummyBuffer], { type: 'image/jpeg' });
    formData.append('photo', blob, 'test.jpg');
    return formData;
  }

  console.log('\n[TEST 1] Kiểm tra nộp ảnh hợp lệ & BullMQ Enqueue (Phase 2):');
  const res1 = await fetch(`${API_BASE}/api/students/2/photo`, {
    method: 'POST',
    body: createFormData(),
  });
  const data1 = (await res1.json()) as any;
  console.log(`Status: ${res1.status}`, data1);
  if (res1.status !== 200 || !data1.jobId) {
    throw new Error(`Test 1 Thất bại! Status: ${res1.status}`);
  }
  console.log('-> PASS: Job đã được enqueue vào BullMQ thành công với ID:', data1.jobId);

  console.log('\n[TEST 2] Kiểm tra Atomic Conflict khi nộp lại cho học sinh vừa claim:');
  const res2 = await fetch(`${API_BASE}/api/students/2/photo`, {
    method: 'POST',
    body: createFormData(),
  });
  console.log(`Status: ${res2.status}`, await res2.json());
  if (res2.status !== 409) {
    throw new Error(`Test 2 Thất bại! Mong đợi 409, nhận được ${res2.status}`);
  }
  console.log('-> PASS: Chặn conflict 409 thành công.');

  console.log('\n[TEST 3] Kiểm tra Redis Sliding Window Rate Limit (5 req / 5 phút):');
  // Chúng ta đã gửi 2 request. Bây giờ gửi thêm 3 request nữa (tổng 5).
  for (let i = 3; i <= 5; i++) {
    const res = await fetch(`${API_BASE}/api/students/2/photo`, {
      method: 'POST',
      body: createFormData(),
    });
    console.log(`Request #${i} status: ${res.status}`);
  }

  // Request thứ 6 PHẢI bị chặn với HTTP 429
  const res6 = await fetch(`${API_BASE}/api/students/2/photo`, {
    method: 'POST',
    body: createFormData(),
  });
  const data6 = (await res6.json()) as any;
  console.log(`Request #6 (Mong đợi 429) status: ${res6.status}`, data6);
  if (res6.status !== 429) {
    throw new Error(`Test 3 Thất bại! Mong đợi 429, nhận được ${res6.status}`);
  }
  console.log('-> PASS: Rate limit kích hoạt thành công (429 Too Many Requests).');

  console.log('\n[TEST 4] Kiểm tra Bypass Rate Limit bằng Teacher PIN (x-teacher-pin):');
  const resBypass = await fetch(`${API_BASE}/api/students/2/photo`, {
    method: 'POST',
    body: createFormData(),
    headers: {
      'x-teacher-pin': classRecord.token, // Token giáo viên hợp lệ
    },
  });
  console.log(`Status với PIN giáo viên: ${resBypass.status} (không bị 429, nhận 409 vì student pending)`);
  if (resBypass.status === 429) {
    throw new Error('Test 4 Thất bại! Vẫn bị chặn 429 dù có PIN giáo viên.');
  }
  console.log('-> PASS: Teacher PIN bypass thành công!');

  console.log('\n[TEST 5] Kiểm tra Class Lock Guard (HTTP 423):');
  await classRepo.setClassLock(classRecord.id, true); // Khóa lớp
  const resLock = await fetch(`${API_BASE}/api/students/2/photo`, {
    method: 'POST',
    body: createFormData(),
  });
  console.log(`Status khi lớp bị khóa: ${resLock.status}`, await resLock.json());
  if (resLock.status !== 423) {
    throw new Error(`Test 5 Thất bại! Mong đợi 423, nhận được ${resLock.status}`);
  }
  console.log('-> PASS: Class Lock Guard trả về 423 Locked thành công!');

  // Cleanup
  await classRepo.setClassLock(classRecord.id, false);
  await closeRedisClient(redis);
  await closeDbPool(pool);

  console.log('\n🎉 TOÀN BỘ 5/5 BÀI TEST CHECKPOINT PHASE 1 & 2 ĐỀU PASS 100%!');
}

main().catch((err) => {
  console.error('LỖI TEST:', err);
  process.exit(1);
});
