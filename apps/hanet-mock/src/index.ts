import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  disableRequestLogging: false,
});

// ═══ Health Check ═══
app.get('/health', async (_request, reply) => {
  return reply.status(200).send({
    status: 'ok',
    service: 'hanet-mock',
    version: '1.0.0',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ═══ Bootstrap ═══
const start = async () => {
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`[hanet-mock] listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// ═══ Graceful Shutdown ═══
const shutdown = async (signal: string) => {
  app.log.info(`[hanet-mock] Received ${signal}, shutting down...`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
