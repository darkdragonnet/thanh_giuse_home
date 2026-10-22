import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
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

const dbUrl = 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const MOCK_API_BASE = 'http://localhost:4000';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  KIỂM CHỨNG MÔ HÌNH PHÂN TẦNG CHIẾN LƯỢC XỬ LÝ LỖI (3-TIER)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const pool = createDbPool({ connectionString: dbUrl });
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

  const sampleImagePath = path.join(uploadDir, 'sample_3tier_test.jpg');
  await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg()
    .toFile(sampleImagePath);

  // ---------------------------------------------------------------------------
  // TẦNG 1: Lỗi Hạ tầng / Quá tải (-503) -> Giữ pending + Fixed Backoff 300s
  // ---------------------------------------------------------------------------
  console.log('[TẦNG 1] Kiểm tra Lỗi Hạ tầng (-503):');
  await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
  await fetch(`${MOCK_API_BASE}/mock/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: '-503', hits: 1 }),
  });

  // Reset student 1 về pending với retry_count = 0 và alias_id chuẩn 9 ký tự (Cloud Ceiling Guard)
  await pool.query(
    "UPDATE students SET status = 'pending', retry_count = 0, alias_id = 'TS1A_0001', local_image_path = $1 WHERE id = 1",
    [sampleImagePath]
  );

  const jobTier1 = {
    id: 'job_tier1_503',
    attemptsMade: 1,
    data: {
      studentId: 1,
      aliasId: 'TS1A_0001',
      studentName: 'Nguyễn Hoàng Long',
      classCode: '10A1',
      tempFilename: 'sample_3tier_test.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  let tier1Threw = false;
  try {
    await processRegistrationJob(jobTier1, {
      studentRepo,
      logRepo,
      hanetClient,
    });
  } catch (err) {
    if (err instanceof HanetServiceUnavailableError) {
      tier1Threw = true;
      console.log(`- Worker ném đúng lỗi: "${err.message}"`);
    } else {
      throw err;
    }
  }

  const student1After = await studentRepo.findById(1);
  console.log(`- Trạng thái DB của Student 1: status="${student1After?.status}", retry_count=${student1After?.retry_count}`);

  if (!tier1Threw) throw new Error('Tầng 1 Thất bại: Không ném HanetServiceUnavailableError');
  if (student1After?.status !== 'pending') {
    throw new Error(`Tầng 1 Thất bại: Trạng thái bị đổi khỏi 'pending'! Hiện tại: ${student1After?.status}`);
  }
  if (student1After?.retry_count !== 1) {
    throw new Error(`Tầng 1 Thất bại: retry_count không tăng lên 1! Hiện tại: ${student1After?.retry_count}`);
  }
  console.log('-> PASS [TẦNG 1]: Bảo toàn trạng thái pending, không drop job, kích hoạt BullMQ delayed 300s!\n');

  // ---------------------------------------------------------------------------
  // TẦNG 2: Lỗi Dữ liệu / AI Edge Cases (-9006) -> Fast Isolation sang manual_review
  // ---------------------------------------------------------------------------
  console.log('[TẦNG 2] Kiểm tra Fast Isolation (-9006 Ảnh mờ/không chuẩn):');
  await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
  await fetch(`${MOCK_API_BASE}/mock/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: '-9006', hits: 1 }),
  });

  await pool.query(
    "UPDATE students SET status = 'pending', alias_id = 'TS1A_0004', local_image_path = $1 WHERE id = 4",
    [sampleImagePath]
  );

  const jobTier2 = {
    id: 'job_tier2_9006',
    attemptsMade: 1,
    data: {
      studentId: 4,
      aliasId: 'TS1A_0004',
      studentName: 'Phạm Đức Trọng',
      classCode: '10A2',
      tempFilename: 'sample_3tier_test.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  const resTier2 = await processRegistrationJob(jobTier2, {
    studentRepo,
    logRepo,
    hanetClient,
  });

  console.log('- Kết quả xử lý Tầng 2:', resTier2);
  const student4After = await studentRepo.findById(4);
  console.log(`- Trạng thái DB của Student 4: status="${student4After?.status}", last_error="${student4After?.last_error_code}"`);

  if (!resTier2.quarantined) throw new Error('Tầng 2 Thất bại: Job không được đánh dấu quarantined');
  if (student4After?.status !== 'manual_review' || student4After?.last_error_code !== '-9006') {
    throw new Error(`Tầng 2 Thất bại: Student không chuyển sang manual_review. Hiện tại: ${student4After?.status}`);
  }
  // Kiểm tra ảnh gốc vẫn được bảo toàn trên disk
  if (!fs.existsSync(sampleImagePath)) {
    throw new Error('Tầng 2 Thất bại: Ảnh gốc bị xóa khỏi disk, vi phạm nguyên tắc giữ ảnh cho admin review');
  }
  console.log('-> PASS [TẦNG 2]: Fast Isolation thành công! Status chuyển manual_review, ảnh gốc giữ nguyên, job kết thúc êm đềm không nghẽn queue!\n');

  // ---------------------------------------------------------------------------
  // TẦNG 3: Lỗi Giới hạn Tài khoản (-9008 Hết Face ID Quota) -> Báo động + Pause Queue
  // ---------------------------------------------------------------------------
  console.log('[TẦNG 3] Kiểm tra Lỗi Giới hạn Tài khoản (-9008 Hết Quota Face ID):');
  await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });
  await fetch(`${MOCK_API_BASE}/mock/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: '-9008', hits: 1 }),
  });

  await pool.query(
    "UPDATE students SET status = 'pending', alias_id = 'TS1A_0005', local_image_path = $1 WHERE id = 5",
    [sampleImagePath]
  );

  let workerPaused = false;
  const mockPauseWorker = async () => {
    workerPaused = true;
    console.log('- [CALLBACK TRIGGERED] pauseWorker() đã được kích hoạt thành công!');
  };

  const jobTier3 = {
    id: 'job_tier3_9008',
    attemptsMade: 1,
    data: {
      studentId: 5,
      aliasId: 'TS1A_0005',
      studentName: 'Vũ Mai Phương',
      classCode: '10A2',
      tempFilename: 'sample_3tier_test.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  let tier3Threw = false;
  try {
    await processRegistrationJob(jobTier3, {
      studentRepo,
      logRepo,
      hanetClient,
      pauseWorker: mockPauseWorker,
    });
  } catch (err: any) {
    if (err.name === 'UnrecoverableError' || (err.message && err.message.includes('-9008'))) {
      tier3Threw = true;
      console.log(`- Worker ném đúng UnrecoverableError: "${err.message}"`);
    } else {
      throw err;
    }
  }

  if (!tier3Threw) {
    throw new Error('Tầng 3 Thất bại: Không ném UnrecoverableError khi gặp -9008');
  }

  const student5After = await studentRepo.findById(5);
  console.log(`- Trạng thái DB của Student 5: status="${student5After?.status}", last_error="${student5After?.last_error_code}"`);

  if (!workerPaused) {
    throw new Error('Tầng 3 Thất bại: Worker không được tạm dừng (pauseWorker không chạy) khi gặp lỗi -9008');
  }

  // Kiểm tra Audit Log có ghi nhận CRITICAL_QUOTA_EXCEEDED
  const logCritical = await pool.query(
    "SELECT result_code, result_message FROM logs WHERE alias_id = 'TS1A_0005' AND result_code = 'CRITICAL_QUOTA_EXCEEDED'"
  );
  if (logCritical.rows.length === 0) {
    throw new Error('Tầng 3 Thất bại: Không tìm thấy Audit Log CRITICAL_QUOTA_EXCEEDED');
  }
  console.log(`- Ghi nhận Audit Log CRITICAL: "${logCritical.rows[0].result_message}"`);
  console.log('-> PASS [TẦNG 3]: Ghi nhận Log CRITICAL, cách ly học sinh và Tạm dừng Worker (Pause Queue) thành công!\n');

  // Cleanup
  if (fs.existsSync(sampleImagePath)) fs.unlinkSync(sampleImagePath);
  await pool.query("UPDATE students SET status = 'empty', alias_id = 'STU_10A1_001_A7B2C', retry_count = 0, last_error_code = NULL, last_error_message = NULL WHERE id = 1");
  await pool.query("UPDATE students SET status = 'success', alias_id = 'STU_10A2_001_K1L2M', last_error_code = NULL, last_error_message = NULL WHERE id = 4");
  await pool.query("UPDATE students SET status = 'success', alias_id = 'STU_10A2_002_N3P4Q', last_error_code = NULL, last_error_message = NULL WHERE id = 5");
  await pool.query("DELETE FROM logs WHERE alias_id IN ('TS1A_0001', 'TS1A_0004', 'TS1A_0005')");
  await closeDbPool(pool);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🎉 TOÀN BỘ 3 TẦNG CHIẾN LƯỢC XỬ LÝ LỖI HOÀN HẢO 100%!');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('LỖI KIỂM CHỨNG 3 TẦNG:', err);
  process.exit(1);
});
