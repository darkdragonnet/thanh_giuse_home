import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

let dbUrl = process.env.DATABASE_URL || 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
let redisUrl = process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@localhost:6379/0';

// Tự động chuyển hostname từ docker sang localhost khi chạy ngoài container
if (!fs.existsSync('/.dockerenv')) {
  if (dbUrl.includes('@postgres:')) {
    dbUrl = dbUrl.replace('@postgres:', '@localhost:');
  }
  if (redisUrl.includes('@redis:')) {
    redisUrl = redisUrl.replace('@redis:', '@localhost:');
  }
}

const defaultUploadDir = !fs.existsSync('/.dockerenv')
  ? path.resolve(process.cwd(), 'uploads')
  : (process.env.UPLOAD_DIR || '/app/uploads');

export const apiEnv = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? process.env.API_PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',

  db: {
    connectionString: dbUrl,
    max: 10, // API connection pool
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  },

  redis: {
    url: redisUrl,
  },

  uploadDir: defaultUploadDir,
  jwtSecret: process.env.JWT_SECRET || 'super_secret_jwt_key_for_admin_session_change_me',
} as const;

export type ApiEnv = typeof apiEnv;
