import { Redis } from 'ioredis';
import { Queue } from 'bullmq';

export const REDIS_KEY_SYSTEM_REGISTRATION_DISABLED = 'system:registration_disabled';

let redisClient: Redis | null = null;
let registrationQueue: Queue | null = null;

export function getSystemLockRedis(): Redis {
  if (!redisClient) {
    let url = process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@localhost:6379/0';
    url = url.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redisClient = new Redis(url, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

export function getSystemLockQueue(): Queue {
  if (!registrationQueue) {
    const redis = getSystemLockRedis();
    registrationQueue = new Queue('registration_queue', { connection: redis });
  }
  return registrationQueue;
}

export async function disableSystemRegistration(reason = 'Quota face exceeded'): Promise<void> {
  const redis = getSystemLockRedis();
  const queue = getSystemLockQueue();

  await redis.set(REDIS_KEY_SYSTEM_REGISTRATION_DISABLED, 'true');
  await queue.pause();
  console.warn(`[SYSTEM LOCK] Đã khóa hệ thống và ngắt hàng đợi BullMQ: ${reason}`);
}

export async function enableSystemRegistration(): Promise<void> {
  const redis = getSystemLockRedis();
  const queue = getSystemLockQueue();

  await redis.del(REDIS_KEY_SYSTEM_REGISTRATION_DISABLED);
  await queue.resume();
  console.log('[SYSTEM LOCK] Đã kích hoạt lại hệ thống và mở lại hàng đợi BullMQ');
}
