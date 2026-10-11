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
import { processFaceImage } from '../apps/worker/src/imageProcessor.js';
import {
  processRegistrationJob,
  HanetServiceUnavailableError,
} from '../apps/worker/src/processor.js';

const dbUrl = 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const MOCK_API_BASE = 'http://localhost:4000';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  KIỂM CHỨNG TOÀN DIỆN PHASE 3 & PHASE 4: WORKER PIPELINE');
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

  // Tạo ảnh mẫu JPEG hợp lệ (kích thước ban đầu 800x600)
  const sampleImagePath = path.join(uploadDir, 'sample_student_input.jpg');
  await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 50, g: 120, b: 200 },
    },
  })
    .jpeg()
    .toFile(sampleImagePath);

  // ---------------------------------------------------------------------------
  // TEST 1: Kiểm thử Sharp Image Processor (1280x736 & RAM Safe)
  // ---------------------------------------------------------------------------
  console.log('[TEST 1] Kiểm tra Sharp resize chuẩn 1280×736 & cấu hình bộ nhớ:');
  const resized = await processFaceImage(sampleImagePath, tmpFacesDir, 'TEST_ALIAS');
  const meta = await sharp(resized.outputPath).metadata();

  console.log(`- Kích thước ảnh xuất: ${meta.width}x${meta.height}`);
  console.log(`- Định dạng: ${meta.format}, dung lượng: ${resized.sizeBytes} bytes`);

  if (meta.width !== 1280 || meta.height !== 736) {
    throw new Error(`Test 1 Thất bại: Kích thước mong đợi 1280x736, nhận được ${meta.width}x${meta.height}`);
  }
  console.log('-> PASS: Sharp đã chuẩn hóa ảnh chính xác về 1280×736 JPEG!\n');

  // Reset Mock Server state
  await fetch(`${MOCK_API_BASE}/mock/reset`, { method: 'DELETE' });

  // ---------------------------------------------------------------------------
  // TEST 2: Kịch bản Đăng ký Thành công (Success Scenario)
  // ---------------------------------------------------------------------------
  console.log('[TEST 2] Pipeline Đăng ký thành công (Student 1 - Nguyễn Hoàng Long):');
  // Reset student 1 về pending
  await pool.query(
    "UPDATE students SET status = 'pending', local_image_path = $1, person_id = NULL, face_url = NULL WHERE id = 1",
    [sampleImagePath]
  );

  const mockJobSuccess = {
    id: 'student_STU_10A1_001_A7B2C',
    data: {
      studentId: 1,
      aliasId: 'STU_10A1_001_A7B2C',
      studentName: 'Nguyễn Hoàng Long',
      classCode: '10A1',
      tempFilename: 'sample_student_input.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  const resSuccess = await processRegistrationJob(mockJobSuccess, {
    studentRepo,
    logRepo,
    hanetClient,
  });

  console.log('- Kết quả xử lý job:', resSuccess);
  if (!resSuccess.success || !resSuccess.personId) {
    throw new Error('Test 2 Thất bại: Đăng ký thành công nhưng không nhận được personId');
  }

  const student1 = await studentRepo.findById(1);
  if (student1?.status !== 'success' || !student1.person_id) {
    throw new Error(`Test 2 Thất bại: Database không cập nhật status 'success'. Hiện tại: ${student1?.status}`);
  }
  console.log('-> PASS: Student 1 đã chuyển thành status="success" với person_id:', student1.person_id, '\n');

  // ---------------------------------------------------------------------------
  // TEST 3: Kịch bản Lỗi khuôn mặt (-9006) -> Cách ly Manual Review
  // ---------------------------------------------------------------------------
  console.log('[TEST 3] Pipeline Lỗi khuôn mặt (-9006) -> Tự động cách ly sang manual_review:');
  const aliasIdErr = 'STU_10A2_001_K1L2M';
  // Thiết lập Global scenario -9006 cho 1 lần gọi (hits: 1)
  await fetch(`${MOCK_API_BASE}/mock/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: '-9006', hits: 1 }),
  });

  await pool.query(
    "UPDATE students SET status = 'pending', local_image_path = $1 WHERE id = 4",
    [sampleImagePath]
  );

  const mockJobErr = {
    id: `student_${aliasIdErr}`,
    data: {
      studentId: 4,
      aliasId: aliasIdErr,
      studentName: 'Phạm Đức Trọng',
      classCode: '10A2',
      tempFilename: 'sample_student_input.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  const resErr = await processRegistrationJob(mockJobErr, {
    studentRepo,
    logRepo,
    hanetClient,
  });

  console.log('- Kết quả xử lý job lỗi:', resErr);
  if (!resErr.quarantined) {
    throw new Error('Test 3 Thất bại: Job không được đánh dấu quarantined');
  }

  const student4 = await studentRepo.findById(4);
  if (student4?.status !== 'manual_review') {
    throw new Error(`Test 3 Thất bại: Trạng thái trong DB không phải 'manual_review'. Hiện tại: ${student4?.status}`);
  }
  console.log('-> PASS: Student 4 đã được cách ly an toàn sang status="manual_review" (không crash worker)!\n');

  // ---------------------------------------------------------------------------
  // TEST 4: Kịch bản Quá tải (-503) -> Kích hoạt Retry Backoff 300s
  // ---------------------------------------------------------------------------
  console.log('[TEST 4] Pipeline HANET Quá tải (-503) -> Ném lỗi kích hoạt BullMQ Backoff:');
  const aliasId503 = 'STU_10A2_002_N3P4Q';
  await fetch(`${MOCK_API_BASE}/mock/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: '-503', hits: 1 }),
  });

  const mockJob503 = {
    id: `student_${aliasId503}`,
    data: {
      studentId: 5,
      aliasId: aliasId503,
      studentName: 'Vũ Mai Phương',
      classCode: '10A2',
      tempFilename: 'sample_student_input.jpg',
      uploadedAt: Date.now(),
      actionType: 'REGISTER' as const,
    },
  } as any;

  let threwRetry = false;
  try {
    await processRegistrationJob(mockJob503, {
      studentRepo,
      logRepo,
      hanetClient,
    });
  } catch (err) {
    if (err instanceof HanetServiceUnavailableError) {
      threwRetry = true;
      console.log(`- Worker ném đúng ngoại lệ HanetServiceUnavailableError: "${err.message}"`);
    } else {
      throw err;
    }
  }

  if (!threwRetry) {
    throw new Error('Test 4 Thất bại: -503 không ném HanetServiceUnavailableError để BullMQ kích hoạt backoff');
  }
  console.log('-> PASS: Lỗi -503 kích hoạt cơ chế Retry Backoff 300s thành công!\n');

  // ---------------------------------------------------------------------------
  // TEST 5: Kịch bản Admin Cập nhật ảnh (UPDATE_PHOTO qua Multipart)
  // ---------------------------------------------------------------------------
  console.log('[TEST 5] Pipeline Admin Cập nhật ảnh (UPDATE_PHOTO cho student 1):');

  const mockJobOverride = {
    id: 'student_STU_10A1_001_A7B2C_override',
    data: {
      studentId: 1,
      aliasId: 'STU_10A1_001_A7B2C',
      studentName: 'Nguyễn Hoàng Long',
      classCode: '10A1',
      tempFilename: 'sample_student_input.jpg',
      uploadedAt: Date.now(),
      actionType: 'UPDATE_PHOTO' as const,
      personId: student1?.person_id || 'mock_HS001_1728470000000',
    },
  } as any;

  const resOverride = await processRegistrationJob(mockJobOverride, {
    studentRepo,
    logRepo,
    hanetClient,
  });

  console.log('- Kết quả cập nhật ảnh:', resOverride);
  if (!resOverride.success) {
    throw new Error('Test 5 Thất bại: Update ảnh qua personID không thành công');
  }
  console.log('-> PASS: Admin UPDATE_PHOTO hoàn thành xuất sắc!\n');

  // Cleanup
  if (fs.existsSync(sampleImagePath)) fs.unlinkSync(sampleImagePath);
  await closeDbPool(pool);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🎉 TẤT CẢ 5/5 BÀI TEST PHASE 3 & 4 ĐỀU PASS 100%!');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('LỖI TEST PHASE 3 & 4:', err);
  process.exit(1);
});
