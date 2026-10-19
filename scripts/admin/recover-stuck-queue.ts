import 'dotenv/config';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

/**
 * Script Quản Trị: Giải cứu toàn diện hàng đợi BullMQ và các học sinh bị kẹt trạng thái 'pending'
 * Chức năng kép:
 *  1. Quét toàn bộ job đang bị trì hoãn (delayed) trong BullMQ và kích hoạt job.promote()
 *  2. Quét toàn bộ học sinh mang trạng thái 'pending' trong PostgreSQL:
 *     - Nếu còn file ảnh trên server: Nạp lại Job vào BullMQ (Priority = 1) để xử lý ngay
 *     - Nếu không còn file ảnh: Hoàn trả trạng thái về 'empty' để học sinh nộp lại an toàn
 */
async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🚀 [RECOVER QUEUE & PENDING] BẮT ĐẦU GIẢI CỨU HỆ THỐNG');
  console.log('════════════════════════════════════════════════════════════════');

  const isInsideDocker = existsSync('/.dockerenv');
  let redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    redisUrl = isInsideDocker
      ? 'redis://:super_secure_redis_password_change_me@app_redis:6379'
      : 'redis://:super_secure_redis_password_change_me@127.0.0.1:6379';
  } else if (!isInsideDocker && redisUrl.includes('@app_redis:')) {
    redisUrl = redisUrl.replace('@app_redis:', '@127.0.0.1:');
  }

  let dbUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
  if (!isInsideDocker && dbUrl.includes('@app_postgres:')) {
    dbUrl = dbUrl.replace('@app_postgres:', '@localhost:');
  }

  const redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  const registrationQueue = new Queue('registration_queue', {
    connection: redisClient,
  });

  const pool = new Pool({
    connectionString: dbUrl,
  });

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // PHẦN 1: GIẢI PHÓNG CÁC JOB BULLMQ ĐANG BỊ DELAY 300S DO CIRCUIT BREAKER CŨ
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[PHẦN 1] Kiểm tra hàng đợi BullMQ:');
    const delayedCount = await registrationQueue.getDelayedCount();
    const waitingCount = await registrationQueue.getWaitingCount();
    const activeCount = await registrationQueue.getActiveCount();
    const failedCount = await registrationQueue.getFailedCount();

    console.log(`   - Delayed (bị kẹt delay):   ${delayedCount}`);
    console.log(`   - Waiting (đang xếp hàng):  ${waitingCount}`);
    console.log(`   - Active (đang xử lý):     ${activeCount}`);
    console.log(`   - Failed (thất bại cũ):    ${failedCount}`);

    if (delayedCount > 0) {
      console.log(`\n🔄 Đang giải phóng ${delayedCount} job delayed sang waiting...`);
      const delayedJobs = await registrationQueue.getDelayed();
      let promotedSuccess = 0;

      for (const job of delayedJobs) {
        const alias = job.data?.aliasId || job.data?.tempFilename || 'N/A';
        const studentName = job.data?.studentName || 'Học sinh';
        try {
          await job.promote();
          promotedSuccess++;
          console.log(`   ✔ [PROMOTED] Job ${job.id} | ${studentName} (${alias})`);
        } catch (err: any) {
          console.error(`   ❌ [ERROR] Job ${job.id} (${alias}): ${err.message}`);
        }
      }
      console.log(`   -> Đã promote thành công: ${promotedSuccess}/${delayedCount} job.`);
    } else {
      console.log('   ✔ Không có job nào đang bị trì hoãn trong BullMQ.');
    }

    // ═════════════════════════════════════════════════════════════════════════
    // PHẦN 2: QUÉT TOÀN BỘ HỌC SINH BỊ KẸT TRẠNG THÁI 'pending' TRONG POSTGRESQL
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n[PHẦN 2] Quét học sinh bị kẹt trạng thái "pending" trong CSDL:');
    const pendingStudentsRes = await pool.query<{
      id: number;
      name: string;
      alias_id: string | null;
      qr_token: string;
      class_id: number | null;
      local_image_path: string | null;
      person_id: string | null;
      class_code: string | null;
    }>(`
      SELECT s.id, s.name, s.alias_id, s.qr_token, s.class_id, s.local_image_path, s.person_id, c.code as class_code
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      WHERE s.status = 'pending'
      ORDER BY s.id ASC
    `);

    const pendingStudents = pendingStudentsRes.rows;
    console.log(`   🔍 Phát hiện ${pendingStudents.length} học sinh đang ở trạng thái 'pending'.`);

    if (pendingStudents.length > 0) {
      let requeuedCount = 0;
      let resetCount = 0;

      for (const student of pendingStudents) {
        let hasImage = false;
        let finalImagePath = student.local_image_path;

        if (finalImagePath) {
          // Kiểm tra absolute path hoặc relative trong uploadDir
          if (existsSync(finalImagePath)) {
            hasImage = true;
          } else {
            // Thử tìm trong thư mục uploads thông dụng
            const uploadDir = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
            const candidate = path.join(uploadDir, path.basename(finalImagePath));
            if (existsSync(candidate)) {
              hasImage = true;
              finalImagePath = candidate;
            }
          }
        }

        const safeIdentifier = student.alias_id || student.qr_token || String(student.id);
        const isUpdate = Boolean(student.person_id);
        const actionType = isUpdate ? 'UPDATE_PHOTO' : 'REGISTER';
        const classCode = student.class_code || 'TS1A';

        if (hasImage && finalImagePath) {
          const tempFilename = path.basename(finalImagePath);
          const jobId = `recover_${safeIdentifier}_${Date.now()}`;

          await registrationQueue.add(
            isUpdate ? 'override-photo' : 'register',
            {
              studentId: student.id,
              aliasId: student.alias_id || undefined,
              qrToken: student.qr_token,
              studentName: student.name,
              classCode,
              tempFilename,
              uploadedAt: Date.now(),
              actionType,
              ...(student.person_id ? { personId: student.person_id } : {}),
            },
            {
              jobId,
              priority: 1, // Priority cao nhất để worker xử lý ngay
              removeOnComplete: true,
            }
          );

          requeuedCount++;
          console.log(
            `   ⚡ [RE-QUEUED] Học sinh ${student.name} (${classCode} - ${safeIdentifier}) -> Đã nạp lại Job ${jobId}`
          );
        } else {
          // Không còn file ảnh trên server -> Hoàn trả về 'empty' để học sinh nộp lại
          await pool.query(
            `UPDATE students 
             SET status = 'empty', local_image_path = NULL, retry_count = 0, last_error_code = NULL, updated_at = NOW() 
             WHERE id = $1`,
            [student.id]
          );
          resetCount++;
          console.log(
            `   🔄 [RESET EMPTY] Học sinh ${student.name} (${classCode}) không còn file ảnh -> Đã reset về 'empty'`
          );
        }
      }

      console.log('\n════════════════════════════════════════════════════════════════');
      console.log(`🎉 [KẾT QUẢ ĐỒNG BỘ CSDL]:`);
      console.log(`   - Đã nạp lại vào hàng đợi xử lý ngay: ${requeuedCount} học sinh`);
      console.log(`   - Đã hoàn trả trạng thái về 'empty':   ${resetCount} học sinh`);
      console.log('════════════════════════════════════════════════════════════════');
    } else {
      console.log('   ✔ CSDL hoàn toàn sạch, không có học sinh nào bị kẹt "pending".');
    }
  } catch (error: any) {
    console.error('❌ Lỗi khi thực thi giải cứu:', error.message);
  } finally {
    await registrationQueue.close();
    await redisClient.quit();
    await pool.end();
    console.log('🔌 Đã ngắt kết nối an toàn với Redis, BullMQ và PostgreSQL. Thoát tiến trình.');
    process.exit(0);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}

export { main as recoverStuckQueue };
