import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { checkDbConnection } from '../shared/db/index.js';
import { checkRedisConnection } from '../shared/redis/index.js';

dotenv.config();

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
  disableRequestLogging: false,
});

await fastify.register(cors, {
  origin: true,
});

// Endpoint kiểm tra sức khỏe hệ thống (Health Check)
fastify.get('/api/health', async (request, reply) => {
  const dbOk = await checkDbConnection();
  const redisOk = await checkRedisConnection();

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

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = '0.0.0.0';
    await fastify.listen({ port, host });
    fastify.log.info(`[FASTIFY SERVER] API đang lắng nghe tại http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
