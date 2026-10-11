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

const API_BASE = 'http://localhost:3000';
const dbUrl = 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const redisUrl = 'redis://:super_secure_redis_password_change_me@localhost:6379/0';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PHASE 5: KIỂM THỬ TÍCH HỢP TOÀN DIỆN END-TO-END PIPELINE');
  console.log('  (HTTP Multipart Upload -> BullMQ -> Worker Sharp -> HANET)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const pool = createDbPool({ connectionString: dbUrl });
  const redis = createRedisClient({ url: redisUrl });
  const studentRepo = new StudentRepository(pool);
  const logRepo = new LogRepository(pool);

  // Chuẩn bị học sinh id=3 (Lê Thị Thu Thảo, 10A1)
  await pool.query(
    "UPDATE students SET status = 'empty', local_image_path = NULL, person_id = NULL, face_url = NULL WHERE id = 3"
  );
  await redis.del('ratelimit:ip:127.0.0.1');

  // Tạo file ảnh mẫu test nộp qua HTTP
  const tempUploadImg = path.resolve('test_student_3_upload.jpg');
  await sharp({
    create: {
      width: 900,
      height: 700,
      channels: 3,
      background: { r: 70, g: 150, b: 230 },
    },
  })
    .jpeg()
    .toFile(tempUploadImg);

  const fileBytes = fs.readFileSync(tempUploadImg);
  const formData = new FormData();
  formData.append('photo', new Blob([fileBytes], { type: 'image/jpeg' }), 'student3.jpg');

  console.log('[BƯỚC 1] Gửi HTTP POST nộp ảnh tới Fastify API (/api/students/3/photo)...');
  const uploadRes = await fetch(`${API_BASE}/api/students/3/photo`, {
    method: 'POST',
    body: formData,
  });

  const uploadJson = (await uploadRes.json()) as any;
  console.log(`- API Phản hồi HTTP ${uploadRes.status}:`, uploadJson);

  if (uploadRes.status !== 200 || !uploadJson.jobId) {
    throw new Error(`Upload thất bại! Mã HTTP: ${uploadRes.status}`);
  }
  console.log('-> API tiếp nhận thành công và sinh Job ID:', uploadJson.jobId);

  console.log('\n[BƯỚC 2] Chờ Worker BullMQ tiêu thụ và xử lý Job từ Redis...');
  let completed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const stu = await studentRepo.findById(3);
    if (stu?.status === 'success') {
      completed = true;
      console.log(`- Worker hoàn tất sau ${(i + 1) * 0.5}s! Student status: ${stu.status}, person_id: ${stu.person_id}`);
      break;
    }
  }

  if (!completed) {
    const finalStu = await studentRepo.findById(3);
    throw new Error(`Worker không hoàn thành job trong thời gian chờ. Trạng thái hiện tại: ${finalStu?.status}`);
  }

  console.log('\n[BƯỚC 3] Kiểm tra Audit Log trong PostgreSQL...');
  const logsRes = await pool.query(
    "SELECT action, result_code, result_message FROM logs WHERE alias_id = 'STU_10A1_003_G8H9J' ORDER BY id DESC LIMIT 2"
  );
  console.log('- Các bản ghi Audit Log:', logsRes.rows);

  const hasQueued = logsRes.rows.some((r: any) => r.result_code === 'QUEUED');
  const hasSuccess = logsRes.rows.some((r: any) => r.result_code === 'SUCCESS');

  if (!hasQueued || !hasSuccess) {
    throw new Error('Audit log không ghi nhận đủ luồng QUEUED và SUCCESS!');
  }
  console.log('-> Audit Log ghi nhận đầy đủ chu trình: QUEUED -> SUCCESS!');

  // Dọn dẹp
  if (fs.existsSync(tempUploadImg)) fs.unlinkSync(tempUploadImg);
  await closeRedisClient(redis);
  await closeDbPool(pool);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🎉 PIPELINE E2E HOÀN THIỆN: 100% PASS!');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('LỖI E2E:', err);
  process.exit(1);
});
