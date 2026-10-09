import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@localhost:6379/0';

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null, // Bắt buộc cho BullMQ
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('[REDIS CLIENT ERROR]:', err);
});

export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (error) {
    console.error('[REDIS HEALTHCHECK FAILED]:', error);
    return false;
  }
}
