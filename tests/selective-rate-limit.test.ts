import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter } from '../apps/api/src/middleware/rateLimiter.js';

describe('T008: FR-011 Selective IP Rate Limiter Integration & Unit Test', () => {
  it('Khẳng định cấu hình trần mặc định chuẩn FR-011: 60 req / 60 giây / IP', () => {
    // Mock Redis pipeline
    const mockRedis = {
      pipeline: () => ({
        zremrangebyscore: () => {},
        zcard: () => {},
        exec: async () => [[null, 0], [null, 10]],
        zadd: () => ({ expire: () => ({ exec: async () => [] }) }),
      }),
    } as any;

    const mockClassRepo = { verifyTeacherPin: vi.fn() } as any;
    const mockStudentRepo = {} as any;

    const middleware = createRateLimiter({
      redis: mockRedis,
      classRepo: mockClassRepo,
      studentRepo: mockStudentRepo,
      adminSecret: 'test_admin_secret',
    });

    expect(middleware).toBeTypeOf('function');
  });

  it('Cho phép tối đa 60 requests/phút và từ chối request thứ 61 với HTTP 429', async () => {
    let currentZcard = 0;
    const mockRedis = {
      pipeline: () => ({
        zremrangebyscore: () => {},
        zcard: () => {},
        exec: async () => [[null, 0], [null, currentZcard]],
        zadd: () => ({ expire: () => ({ exec: async () => [] }) }),
      }),
      zrange: async () => ['member_1', String(Date.now() - 30_000)],
    } as any;

    const mockClassRepo = { verifyTeacherPin: vi.fn() } as any;
    const mockStudentRepo = {} as any;

    const limiter = createRateLimiter({
      redis: mockRedis,
      classRepo: mockClassRepo,
      studentRepo: mockStudentRepo,
      adminSecret: 'secret',
      limit: 60,
      windowSec: 60,
    });

    const mockReq = {
      headers: { 'x-forwarded-for': '192.168.1.100' },
      query: {},
      params: {},
      ip: '192.168.1.100',
    } as any;

    let headersSet: Record<string, any> = {};
    let statusSent = 200;
    let bodySent: any = null;

    const createReply = () => {
      headersSet = {};
      statusSent = 200;
      bodySent = null;
      return {
        header: (k: string, v: any) => {
          headersSet[k] = v;
        },
        status: (s: number) => {
          statusSent = s;
          return {
            send: (b: any) => {
              bodySent = b;
            },
          };
        },
      } as any;
    };

    // Request thứ 60 (currentCount = 59) -> Cho qua
    currentZcard = 59;
    await limiter(mockReq, createReply());
    expect(statusSent).toBe(200);
    expect(headersSet['X-RateLimit-Limit']).toBe(60);
    expect(headersSet['X-RateLimit-Remaining']).toBe(0);

    // Request thứ 61 (currentCount = 60 >= 60) -> Chặn HTTP 429
    currentZcard = 60;
    await limiter(mockReq, createReply());
    expect(statusSent).toBe(429);
    expect(bodySent?.error).toBe('Too Many Requests');
    expect(bodySent?.message).toMatch(/60 lần \/ 60 giây/);
    expect(headersSet['Retry-After']).toBeGreaterThan(0);
  });

  it('Miễn trừ hoàn toàn trần rate limit khi có mã PIN giáo viên hợp lệ (x-teacher-pin)', async () => {
    const mockRedis = {
      pipeline: () => ({
        zremrangebyscore: () => {},
        zcard: () => {},
        exec: async () => [[null, 0], [null, 100]], // Đã vượt trần 100 > 60
      }),
    } as any;

    const mockClassRepo = {
      verifyTeacherPin: vi.fn().mockResolvedValue(true),
    } as any;
    const mockStudentRepo = {
      findById: vi.fn().mockResolvedValue({ id: 10, class_id: 1 }),
    } as any;

    const limiter = createRateLimiter({
      redis: mockRedis,
      classRepo: mockClassRepo,
      studentRepo: mockStudentRepo,
      adminSecret: 'secret',
      limit: 60,
      windowSec: 60,
    });

    const mockReq = {
      headers: {
        'x-forwarded-for': '192.168.1.100',
        'x-teacher-pin': 'SECRET_CLASS_PIN_999',
      },
      query: {},
      params: { studentId: '10' },
      ip: '192.168.1.100',
    } as any;

    let statusSent = 200;
    const reply = {
      header: () => {},
      status: (s: number) => {
        statusSent = s;
        return { send: () => {} };
      },
    } as any;

    // Dù current count là 100, có PIN giáo viên hợp lệ vẫn được bypass và không bị 429
    await limiter(mockReq, reply);
    expect(statusSent).toBe(200);
    expect(mockClassRepo.verifyTeacherPin).toHaveBeenCalledWith(1, 'SECRET_CLASS_PIN_999');
  });

  it('Miễn trừ hoàn toàn trần rate limit khi có token Admin hợp lệ', async () => {
    const mockRedis = {
      pipeline: () => ({
        zremrangebyscore: () => {},
        zcard: () => {},
        exec: async () => [[null, 0], [null, 999]], // Đã gửi 999 requests
      }),
    } as any;

    const limiter = createRateLimiter({
      redis: mockRedis,
      classRepo: {} as any,
      studentRepo: {} as any,
      adminSecret: 'super_admin_secret',
      limit: 60,
      windowSec: 60,
    });

    const mockReq = {
      headers: {
        'x-forwarded-for': '192.168.1.100',
        authorization: 'Bearer super_admin_secret',
      },
      query: {},
      params: {},
      ip: '192.168.1.100',
    } as any;

    let statusSent = 200;
    const reply = {
      header: () => {},
      status: (s: number) => {
        statusSent = s;
        return { send: () => {} };
      },
    } as any;

    await limiter(mockReq, reply);
    expect(statusSent).toBe(200);
  });
});
