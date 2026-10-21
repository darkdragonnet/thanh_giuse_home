export const WORKER_CONCURRENCY = 1 as const;
export const WORKER_LOCK_DURATION_MS = 120_000 as const;
export const WORKER_DEFAULT_RATE_LIMIT = 1 as const;
export const WORKER_RATE_LIMIT_DURATION_MS = 60_000 as const;

export interface WorkerLimiterConfig {
  max: number;
  duration: number;
}

export interface WorkerOptionsConfig {
  connection: any;
  concurrency: number;
  lockDuration: number;
  limiter: WorkerLimiterConfig;
}

/**
 * Tạo options chuẩn hóa cho BullMQ Worker
 * Tuân thủ Hiến pháp Dự án (Principle II & IV):
 * - concurrency === 1 (bất biến)
 * - lockDuration === 120_000 ms (khớp timeout HANET 120s)
 * - limiter.max === rateLimitPerMin (mặc định 1 req/phút)
 * - limiter.duration === 60_000 ms (1 phút)
 */
export function buildWorkerOptions(
  connection: any = { host: '127.0.0.1', port: 6379 },
  rateLimitPerMin: number = WORKER_DEFAULT_RATE_LIMIT
): WorkerOptionsConfig {
  const max = Number(rateLimitPerMin) > 0 ? Number(rateLimitPerMin) : WORKER_DEFAULT_RATE_LIMIT;
  return {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: WORKER_LOCK_DURATION_MS,
    limiter: {
      max,
      duration: WORKER_RATE_LIMIT_DURATION_MS,
    },
  };
}
