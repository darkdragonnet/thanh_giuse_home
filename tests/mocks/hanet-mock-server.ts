import Fastify from 'fastify';

const mockServer = Fastify({ logger: false });
const MOCK_PORT = 9999;

// Kho lưu trữ in-memory để kiểm tra tính idempotent và trùng lặp
const registeredFaces = new Map<string, { personId: string; name: string }>();

// 1. Mock endpoint Đăng ký khuôn mặt
mockServer.post('/person/register', async (req, reply) => {
  const body = (req.body || {}) as { name: string; alias: string; file_url: string };
  const scenario = req.headers['x-mock-scenario'] as string;

  // Mô phỏng Case 1: Lỗi hết Quota (-9008)
  if (scenario === 'EXCEED_QUOTA') {
    return reply.status(200).send({
      returnCode: -9008,
      message: 'Place has exceeded the maximum number of registered faces',
      data: null,
    });
  }

  // Mô phỏng Case 2: Token hết hạn (-103)
  if (scenario === 'EXPIRED_TOKEN') {
    return reply.status(200).send({
      returnCode: -103,
      message: 'AccessToken has expired',
      data: null,
    });
  }

  // Mô phỏng Case 3: Đã tồn tại khuôn mặt (-9005)
  if (scenario === 'CONFLICT_DIFFERENT_PERSON') {
    return reply.status(200).send({
      returnCode: -9005,
      message: 'Face already registered with another person',
      data: {
        person_id: 'HANET_EXISTING_999',
        alias: 'GLV0_9999', // Alias khác với request
      },
    });
  }

  // Mô phỏng Case 4: Đăng ký thành công hoặc Idempotent
  const alias = body.alias || 'UNKNOWN';
  const existing = registeredFaces.get(alias);
  if (existing) {
    return reply.status(200).send({
      returnCode: 0,
      message: 'Success (Existing)',
      data: { person_id: existing.personId, face_url: body.file_url },
    });
  }

  const generatedPersonId = `HANET_P_${Date.now()}`;
  registeredFaces.set(alias, { personId: generatedPersonId, name: body.name });

  return reply.status(200).send({
    returnCode: 0,
    message: 'Success',
    data: {
      person_id: generatedPersonId,
      face_url: body.file_url,
    },
  });
});

// 2. Mock endpoint Refresh Token
mockServer.post('/auth/refreshToken', async () => {
  return { returnCode: 0, message: 'Token refreshed', data: { accessToken: 'mock_new_token' } };
});

export async function startMockHanet(port = MOCK_PORT) {
  try {
    await mockServer.listen({ port, host: '0.0.0.0' });
    console.log(`[Mock HANET] Running on http://localhost:${port}`);
  } catch (err: any) {
    if (err.code !== 'EADDRINUSE') throw err;
  }
  return mockServer;
}

if (process.argv[1] && process.argv[1].endsWith('hanet-mock-server.ts')) {
  startMockHanet();
}
