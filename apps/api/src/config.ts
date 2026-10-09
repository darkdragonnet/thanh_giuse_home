import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const apiEnv = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',

  db: {
    connectionString: required('DATABASE_URL'),
    max: 10,                     // API cần nhiều connection cho concurrent requests
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  },

  redis: {
    url: required('REDIS_URL'),
  },
} as const;

export type ApiEnv = typeof apiEnv;
