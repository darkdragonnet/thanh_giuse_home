import { FastifyInstance } from 'fastify';
import { mockState } from '../state.js';

interface SetScenarioBody {
  scenario: string;
  delayMs?: number | undefined;
  hits?: number | undefined;
  ttlSeconds?: number | undefined;
}

export async function registerMockControlRoutes(server: FastifyInstance): Promise<void> {
  // Lấy toàn bộ trạng thái hiện tại
  server.get('/mock/state', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      snapshot: mockState.getSnapshot()
    });
  });

  // Thiết lập kịch bản giả lập toàn cục
  server.post<{ Body: SetScenarioBody }>('/mock/scenario', async (request, reply) => {
    const { scenario, delayMs, hits, ttlSeconds } = request.body || {};

    if (!scenario) {
      return reply.status(400).send({
        error: 'Missing required field: scenario'
      });
    }

    mockState.setGlobalScenario(scenario, delayMs, hits, ttlSeconds);

    return reply.status(200).send({
      message: `Global scenario set to '${scenario}'`,
      details: { delayMs, hits, ttlSeconds }
    });
  });

  // Reset toàn bộ Mock State
  server.delete('/mock/reset', async (_request, reply) => {
    mockState.reset();
    return reply.status(200).send({
      message: 'Mock state successfully reset to initial baseline'
    });
  });
}
