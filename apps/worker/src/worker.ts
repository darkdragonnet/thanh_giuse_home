import { Worker, Job } from 'bullmq';
import {
  createRedisClient,
  closeRedisClient,
  createDbPool,
  closeDbPool,
  StudentRepository,
  LogRepository,
  SettingsRepository,
} from '@thanh-giuse/shared-infra';
import { HanetClient } from '@thanh-giuse/hanet-client';
import type { RegistrationJobDataExtended } from '@thanh-giuse/shared-types';
import { workerEnv } from './config.js';
import { processRegistrationJob } from './processor.js';
import { handleUpdateAlias } from './processors/update-alias.processor.js';
import { handleHanetSync2000 } from './processors/hanet-sync.processor.js';

// ═══ Khởi tạo hạ tầng qua factory ═══
const dbPool = createDbPool(workerEnv.db);
const redisClient = createRedisClient(workerEnv.redis);

const studentRepo = new StudentRepository(dbPool);
const logRepo = new LogRepository(dbPool);
const settingsRepo = new SettingsRepository(dbPool);

const hanetClient = new HanetClient({
  baseUrl: workerEnv.hanet.baseUrl,
  token: workerEnv.hanet.token,
  placeId: workerEnv.hanet.placeId,
  timeoutMs: workerEnv.hanet.timeoutMs,
  circuitBreakerThreshold: workerEnv.hanet.circuitBreakerThreshold,
  circuitBreakerCooldownMs: workerEnv.hanet.circuitBreakerCooldownMs,
});

console.log('[WORKER] Starting BullMQ consumer on registration_queue...');
console.log(`[WORKER CONFIG] HANET Base URL: ${workerEnv.hanet.baseUrl} | Static Base: ${workerEnv.staticBaseUrl}`);

// Concurrency = 1 BẤT BIẾN theo Hiến pháp dự án (chống OOM khi Sharp resize)
export const registrationWorker = new Worker(
  'registration_queue',
  async (job: Job) => {
    const context = {
      studentRepo,
      logRepo,
      settingsRepo,
      redisClient,
      hanetClient,
      pauseWorker: async () => {
        console.warn('[WORKER] Kích hoạt tạm dừng Worker (pause queue)!');
        await registrationWorker.pause();
      },
    };

    switch (job.name) {
      case 'update_alias':
        return await handleUpdateAlias(job as Job<any>, context);

      case 'sync_hanet_2000':
        return await handleHanetSync2000(job as Job<any>);

      case 'register_face':
      default:
        return await processRegistrationJob(job as Job<RegistrationJobDataExtended>, context);
    }
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

// ═══ Graceful Shutdown (stop_grace_period: 150s) ═══
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
