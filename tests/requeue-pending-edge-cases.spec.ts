import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

describe('Fastify Empty JSON Body Parser Edge Case', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();

    // Cấu hình Parser chống lỗi FST_ERR_CTP_EMPTY_JSON_BODY
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (!text || text.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    app.post('/test-requeue', async (req, reply) => {
      return reply.send({ success: true, bodyReceived: req.body });
    });

    await app.ready();
  });

  it('1. Cho phép request POST có header Content-Type application/json nhưng body rỗng (length 0)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-requeue',
      headers: {
        'content-type': 'application/json',
      },
      payload: '',
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.bodyReceived).toEqual({});
  });

  it('2. Cho phép request POST có payload là chuỗi rỗng có khoảng trắng', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-requeue',
      headers: {
        'content-type': 'application/json',
      },
      payload: '   ',
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.bodyReceived).toEqual({});
  });

  it('3. Cho phép request POST có payload là JSON hợp lệ', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-requeue',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ force: true }),
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.bodyReceived).toEqual({ force: true });
  });

  it('4. Trả về 400 khi JSON bị sai cú pháp (malformed JSON)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-requeue',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{ malformed json',
    });

    expect(res.statusCode).toBe(400);
  });
});
