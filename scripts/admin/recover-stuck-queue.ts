import 'dotenv/config';
import { existsSync } from 'node:fs';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fileURLToPath } from 'node:url';

/**
 * Script Quản Trị: Giải cứu các job bị kẹt trong BullMQ do Circuit Breaker cũ gây ra
 * Chức năng:
 *  - Quét toàn bộ các job đang bị trì hoãn (delayed) trong 'registration_queue'
 *  - Kích hoạt job.promote() đưa job về trạng thái 'waiting' để worker mới xử lý dứt điểm
 *  - Tự động đóng toàn bộ kết nối Redis / BullMQ và thoát tiến trình sạch sẽ
 */
async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🚀 [RECOVER QUEUE] BẮT ĐẦU QUÉT VÀ GIẢI CỨU HÀNG ĐỢI BULLMQ');
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

  const redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  const registrationQueue = new Queue('registration_queue', {
    connection: redisClient,
  });

  try {
    const delayedCount = await registrationQueue.getDelayedCount();
    const waitingCount = await registrationQueue.getWaitingCount();
    const activeCount = await registrationQueue.getActiveCount();
    const failedCount = await registrationQueue.getFailedCount();

    console.log(`📊 Thống kê hàng đợi hiện tại:`);
    console.log(`   - Delayed (bị kẹt chờ delay): ${delayedCount}`);
    console.log(`   - Waiting (đang xếp hàng):    ${waitingCount}`);
    console.log(`   - Active (đang xử lý):       ${activeCount}`);
    console.log(`   - Failed (thất bại dứt điểm):${failedCount}`);

    if (delayedCount === 0) {
      console.log('✔ Không có job nào đang bị trì hoãn (delayed). Hàng đợi hoàn toàn thông suốt!');
      return;
    }

    console.log(`\n🔄 Đang lấy danh sách ${delayedCount} job delayed để promote...`);
    const delayedJobs = await registrationQueue.getDelayed();

    let promotedSuccess = 0;
    let promotedFailed = 0;

    for (const job of delayedJobs) {
      const alias = job.data?.aliasId || job.data?.tempFilename || 'N/A';
      const studentName = job.data?.studentName || 'Học sinh';

      try {
        await job.promote();
        promotedSuccess++;
        console.log(
          `   [PROMOTED] Job ${job.id} | ${studentName} (${alias}) -> Đã chuyển về hàng đợi active/waiting.`
        );
      } catch (err: any) {
        promotedFailed++;
        console.error(
          `   [ERROR] Không thể promote Job ${job.id} (${alias}): ${err.message}`
        );
      }
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log(`🎉 [KẾT QUẢ] Đã giải cứu thành công ${promotedSuccess}/${delayedCount} job!`);
    if (promotedFailed > 0) {
      console.warn(`⚠ ${promotedFailed} job không thể chuyển trạng thái.`);
    }
    console.log('════════════════════════════════════════════════════════════════');
  } catch (error: any) {
    console.error('❌ Lỗi khi thực thi giải cứu hàng đợi:', error.message);
  } finally {
    // Đóng toàn bộ kết nối để giải phóng socket trên VPS
    await registrationQueue.close();
    await redisClient.quit();
    console.log('🔌 Đã ngắt kết nối an toàn với Redis & BullMQ. Thoát tiến trình.');
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
