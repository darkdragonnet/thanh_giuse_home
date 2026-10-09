import { Worker, Job } from 'bullmq';
import dotenv from 'dotenv';
import { redis } from '../shared/redis/index.js';
import { RegistrationJobData } from '../shared/types/index.js';

dotenv.config();

console.log('[WORKER ENGINE] Đang khởi động BullMQ Consumer...');

// Concurrency = 1 BẤT BIẾN theo Hiến pháp dự án để chống OOM khi giải nén ảnh
export const registrationWorker = new Worker<RegistrationJobData>(
  'registration_queue',
  async (job: Job<RegistrationJobData>) => {
    console.log(`[JOB BẮT ĐẦU] ID: ${job.id} cho Học sinh: ${job.data.studentName} (${job.data.aliasId})`);
    
    // Tạm thời mô phỏng xử lý tuần tự (sẽ tích hợp Sharp và HanetClient ở Phase tiếp theo)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    console.log(`[JOB HOÀN TẤT] ID: ${job.id}`);
    return { success: true };
  },
  {
    connection: redis,
    concurrency: 1, // RÀNG BUỘC CỐT LÕI
    lockDuration: 120000, // Timeout 120 giây
  }
);

registrationWorker.on('completed', (job) => {
  console.log(`[BULLMQ COMPLETED] Job ${job.id} đã hoàn tất`);
});

registrationWorker.on('failed', (job, err) => {
  console.error(`[BULLMQ FAILED] Job ${job?.id} thất bại:`, err.message);
});

// Xử lý Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('[WORKER SIGTERM] Đang đóng worker nhẹ nhàng...');
  await registrationWorker.close();
  process.exit(0);
});
