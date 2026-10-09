import { Worker, Job } from 'bullmq';
import {
  createRedisClient,
  closeRedisClient,
  createDbPool,
  closeDbPool,
} from '@thanh-giuse/shared-infra';
import type { RegistrationJobDataExtended } from '@thanh-giuse/shared-types';
import { workerEnv } from './config.js';

// ═══ Khởi tạo hạ tầng qua factory ═══
const dbPool = createDbPool(workerEnv.db);
const redisClient = createRedisClient(workerEnv.redis);

console.log('[WORKER] Starting BullMQ consumer...');

// Concurrency = 1 BẤT BIẾN theo Hiến pháp dự án (chống OOM khi Sharp resize)
export const registrationWorker = new Worker<RegistrationJobDataExtended>(
  'registration_queue',
  async (job: Job<RegistrationJobDataExtended>) => {
    console.log(
      `[JOB START] ID: ${job.id} | Action: ${job.data.actionType ?? 'REGISTER'} | Student: ${job.data.studentName} (${job.data.aliasId})`
    );

    // Placeholder — sẽ tích hợp Sharp + HANET client ở Phase tiếp theo
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log(`[JOB DONE] ID: ${job.id}`);
    return { success: true };
  },
  {
    connection: redisClient,
    concurrency: 1,          // RÀNG BUỘC CỐT LÕI — KHÔNG ĐƯỢC TĂNG
    lockDuration: 120_000,   // 120s — khớp timeout HANET
  }
);

registrationWorker.on('completed', (job) => {
  console.log(`[BULLMQ COMPLETED] Job ${job.id} done`);
});

registrationWorker.on('failed', (job, err) => {
  console.error(`[BULLMQ FAILED] Job ${job?.id}: ${err.message}`);
});

// ═══ Graceful Shutdown ═══
const shutdown = async (signal: string) => {
  console.log(`[WORKER] Received ${signal}, shutting down gracefully...`);
  try {
    await registrationWorker.close();
    await closeDbPool(dbPool);
    await closeRedisClient(redisClient);
    console.log('[WORKER] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[WORKER] Shutdown error:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
