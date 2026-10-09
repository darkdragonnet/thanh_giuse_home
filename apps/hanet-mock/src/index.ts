import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { registerMockControlRoutes } from './routes/mockControl.js';
import { registerHanetRoutes } from './routes/hanetRoutes.js';
import { mockState } from './state.js';

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

// Đăng ký parser cho form body và multipart form data
await server.register(formbody);
await server.register(multipart, {
  attachFieldsToBody: true,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// Hook ghi log request
server.addHook('onRequest', async (request) => {
  if (!request.url.startsWith('/mock/state') && !request.url.startsWith('/health')) {
    mockState.recordCall({
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      scenarioApplied: (request.headers['x-mock-scenario'] as string) || 'auto',
      clientIp: request.ip
    });
  }
});

// Endpoint Healthcheck
server.get('/health', async () => {
  return {
    status: 'ok',
    service: 'hanet-mock',
    version: '1.0.0',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };
});

// Đăng ký router
await registerMockControlRoutes(server);
await registerHanetRoutes(server);

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Graceful shutdown
const shutdown = async (signal: string) => {
  server.log.info(`[hanet-mock] Received ${signal}, shutting down...`);
  try {
    await server.close();
    process.exit(0);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Mock Server is listening on http://${HOST}:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
