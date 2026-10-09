import Redis from 'ioredis';
import type { RedisConfig } from './types.js';

export function createRedisClient(config: RedisConfig): Redis {
  const client = new Redis(config.url, {
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? null,
    enableReadyCheck: config.enableReadyCheck ?? false,
    retryStrategy: config.retryStrategy ?? ((times) => Math.min(times * 200, 2000)),
  });

  client.on('error', (err) => {
    console.error('[REDIS ERROR]', err);
  });

  return client;
}

export async function closeRedisClient(client: Redis): Promise<void> {
  await client.quit();
}

export async function checkRedisConnection(client: Redis): Promise<boolean> {
  try {
    const pong = await client.ping();
    return pong === 'PONG';
  } catch (error) {
    console.error('[REDIS HEALTHCHECK FAILED]', error);
    return false;
  }
}
