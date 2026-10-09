import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  createDbPool,
  closeDbPool,
  checkDbConnection,
  createRedisClient,
  closeRedisClient,
  checkRedisConnection,
} from '@thanh-giuse/shared-infra';
import { apiEnv } from './config.js';

const fastify = Fastify({
  logger: {
    level: apiEnv.nodeEnv === 'production' ? 'info' : 'debug',
  },
  disableRequestLogging: false,
});

// ═══ Khởi tạo hạ tầng qua factory ═══
const dbPool = createDbPool(apiEnv.db);
const redisClient = createRedisClient(apiEnv.redis);

await fastify.register(cors, {
  origin: true,
});

// ═══ Health Check ═══
fastify.get('/api/health', async (_request, reply) => {
  const dbOk = await checkDbConnection(dbPool);
  const redisOk = await checkRedisConnection(redisClient);
  const isHealthy = dbOk && redisOk;

  return reply.status(isHealthy ? 200 : 503).send({
    success: isHealthy,
    status: isHealthy ? 'UP' : 'DEGRADED',
    services: {
      database: dbOk ? 'CONNECTED' : 'DISCONNECTED',
      redis: redisOk ? 'CONNECTED' : 'DISCONNECTED',
    },
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ═══ Bootstrap ═══
const start = async () => {
  try {
    await fastify.listen({ port: apiEnv.port, host: apiEnv.host });
    fastify.log.info(`[API] listening on http://${apiEnv.host}:${apiEnv.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// ═══ Graceful Shutdown ═══
const shutdown = async (signal: string) => {
  fastify.log.info(`[API] Received ${signal}, shutting down gracefully...`);
  try {
    await fastify.close();
    await closeDbPool(dbPool);
    await closeRedisClient(redisClient);
    fastify.log.info('[API] Shutdown complete');
    process.exit(0);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
