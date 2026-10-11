import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

let dbUrl = process.env.DATABASE_URL || 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
let redisUrl = process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@localhost:6379/0';

// Trong môi trường dev hoặc test ngoài docker, ưu tiên Mock Server localhost:4000
// trừ khi có cờ tường minh HANET_USE_REAL_CLOUD=true
const useRealCloud =
  process.env.HANET_USE_REAL_CLOUD === 'true' ||
  Boolean(process.env.HANET_API_BASE_URL && process.env.HANET_API_BASE_URL.includes('partner.hanet.ai'));
let hanetBaseUrl = useRealCloud
  ? (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai')
  : (process.env.HANET_MOCK_URL || 'http://localhost:4000');

// Tự động chuyển đổi host khi chạy ngoài container Docker
if (!fs.existsSync('/.dockerenv')) {
  dbUrl = dbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
  redisUrl = redisUrl.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
  hanetBaseUrl = hanetBaseUrl.replace('app_mock', 'localhost');
}

const defaultUploadDir = !fs.existsSync('/.dockerenv')
  ? path.resolve(process.cwd(), 'uploads')
  : (process.env.UPLOAD_DIR || '/app/uploads');

const tmpFacesDir = path.join(defaultUploadDir, 'tmp-faces');

export const workerEnv = {
  nodeEnv: process.env.NODE_ENV ?? 'development',

  db: {
    connectionString: dbUrl,
    max: 3,                      // Worker concurrency=1, chỉ cần ít connection
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 5_000,
  },

  redis: {
    url: redisUrl,
  },

  uploadDir: defaultUploadDir,
  tmpFacesDir,

  staticBaseUrl: process.env.STATIC_BASE_URL || (!fs.existsSync('/.dockerenv') ? 'http://localhost:8090/tmp-faces' : 'http://app_proxy/tmp-faces'),

  hanet: {
    baseUrl: hanetBaseUrl,
    token: process.env.HANET_ACCESS_TOKEN || 'mock_token',
    placeId: process.env.HANET_PLACE_ID || '196',
    timeoutMs: 120_000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 300_000,
  },
} as const;

export type WorkerEnv = typeof workerEnv;
