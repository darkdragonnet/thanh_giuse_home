import { describe, it, expect } from 'vitest';
import { Worker } from 'bullmq';
import { EventEmitter } from 'node:events';
import {
  buildWorkerOptions,
  WORKER_DEFAULT_RATE_LIMIT,
  WORKER_RATE_LIMIT_DURATION_MS,
} from '../apps/worker/src/workerOptions.js';

class MockRedisConnection extends EventEmitter {
  status = 'ready';
  options = {};
  duplicate() {
    return new MockRedisConnection();
  }
  client() {
    return Promise.resolve();
  }
  quit() {
    return Promise.resolve('OK');
  }
  disconnect() {}
}

describe('T007: BullMQ HANET Sync Rate Limiter Pacing (FR-007)', () => {
  it('Khẳng định cấu hình limiter mặc định đúng 1 req/phút (duration: 60.000 ms)', () => {
    expect(WORKER_DEFAULT_RATE_LIMIT).toBe(1);
    expect(WORKER_RATE_LIMIT_DURATION_MS).toBe(60_000);

    const opts = buildWorkerOptions();
    expect(opts.limiter).toBeDefined();
    expect(opts.limiter.max).toBe(1);
    expect(opts.limiter.duration).toBe(60_000);
  });

  it('Khẳng định nhịp limiter tương thích giá trị cấu hình hanet_sync_rate_limit', () => {
    // Trường hợp đọc được giá trị 2 req/phút
    const opts2 = buildWorkerOptions(undefined, 2);
    expect(opts2.limiter.max).toBe(2);
    expect(opts2.limiter.duration).toBe(60_000);

    // Trường hợp giá trị null/undefined/0/âm -> tự động fallback về 1
    // @ts-expect-error test runtime fallback
    const optsNull = buildWorkerOptions(undefined, null);
    expect(optsNull.limiter.max).toBe(1);

    const optsZero = buildWorkerOptions(undefined, 0);
    expect(optsZero.limiter.max).toBe(1);
  });

  it('Khẳng định BullMQ Worker nhận diện chính xác cấu hình limiter', async () => {
    const mockConnection = new MockRedisConnection();
    const workerOpts = buildWorkerOptions(mockConnection, 1);

    const testWorker = new Worker('test_rate_limiter_queue', async () => {}, {
      ...workerOpts,
      autorun: false,
    });

    try {
      expect(testWorker.opts.limiter).toBeDefined();
      expect(testWorker.opts.limiter?.max).toBe(1);
      expect(testWorker.opts.limiter?.duration).toBe(60_000);
    } finally {
      await testWorker.close();
    }
  });
});
