import { describe, it, expect } from 'vitest';
import { Worker } from 'bullmq';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkerOptions, WORKER_CONCURRENCY } from '../apps/worker/src/workerOptions.js';

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

describe('T006: Worker Concurrency & Memory Guard (Principle II)', () => {
  it('Khẳng định hằng số WORKER_CONCURRENCY bất biến bằng 1', () => {
    expect(WORKER_CONCURRENCY).toBe(1);
  });

  it('Khẳng định hàm buildWorkerOptions luôn trả về concurrency === 1', () => {
    const optsDefault = buildWorkerOptions();
    expect(optsDefault.concurrency).toBe(1);

    // Dù truyền rate limit nào thì concurrency vẫn bắt buộc là 1
    const optsCustom = buildWorkerOptions(undefined, 5);
    expect(optsCustom.concurrency).toBe(1);
    expect(optsCustom.lockDuration).toBe(120_000);
  });

  it('Khẳng định đối tượng BullMQ Worker khởi tạo có worker.opts.concurrency === 1', async () => {
    const mockConnection = new MockRedisConnection();
    const workerOpts = buildWorkerOptions(mockConnection);

    // Khởi tạo Worker với mock connection và autorun: false để không gọi network
    const testWorker = new Worker('test_concurrency_queue', async () => {}, {
      ...workerOpts,
      autorun: false,
    });

    try {
      expect(testWorker.opts.concurrency).toBe(1);
      expect(testWorker.opts.lockDuration).toBe(120_000);
    } finally {
      await testWorker.close();
    }
  });

  it('Khẳng định docker-compose.yml cấu hình đúng Heap bound 512MB và RAM limit 768MB cho app_worker', () => {
    const composePath = path.resolve(__dirname, '../docker/docker-compose.yml');
    expect(fs.existsSync(composePath)).toBe(true);

    const composeContent = fs.readFileSync(composePath, 'utf-8');

    // Kiểm tra cấu hình app_worker
    const workerBlockMatch = composeContent.match(/app_worker:[\s\S]*?(?=\n\s{2}[a-zA-Z0-9_-]+:|\Z)/);
    expect(workerBlockMatch).not.toBeNull();

    const workerBlock = workerBlockMatch![0];

    // Heap limit
    expect(workerBlock).toMatch(/NODE_OPTIONS:\s*["']?--max-old-space-size=512["']?/);

    // RAM limit
    expect(workerBlock).toMatch(/memory:\s*768M/i);

    // Graceful shutdown period
    expect(workerBlock).toMatch(/stop_grace_period:\s*150s/i);
  });
});
