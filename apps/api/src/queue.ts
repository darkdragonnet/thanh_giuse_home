import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { RegistrationJobDataExtended } from '@thanh-giuse/shared-types';

export function createRegistrationQueue(redisClient: Redis): Queue<RegistrationJobDataExtended> {
  return new Queue<RegistrationJobDataExtended>('registration_queue', {
    connection: redisClient,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'fixed',
        delay: 300_000, // 5 phút khi gặp lỗi -503 HANET quá tải
      },
      removeOnComplete: {
        count: 500, // Bounded lịch sử job completed
      },
      removeOnFail: {
        count: 200,
      },
    },
  });
}
