import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const workerEnv = {
  nodeEnv: process.env.NODE_ENV ?? 'development',

  db: {
    connectionString: required('DATABASE_URL'),
    max: 3,                      // Worker concurrency=1, chỉ cần ít connection
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 5_000,
  },

  redis: {
    url: required('REDIS_URL'),
  },
} as const;

export type WorkerEnv = typeof workerEnv;
