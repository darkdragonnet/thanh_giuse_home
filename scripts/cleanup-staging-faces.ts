import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cleanupStagingCloudFaces } from '@thanh-giuse/shared-infra';

const { Pool } = pg;

/**
 * CLI Dọn dẹp bảng nháp `staging_cloud_faces` sau 7 ngày vận hành ổn định
 * để giải phóng dung lượng ổ cứng SSD 20GB trên VPS.
 */
async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

  const pool = new Pool({ connectionString });
  try {
    const result = await cleanupStagingCloudFaces(pool);
    console.log('✅ Đã thực thi TRUNCATE TABLE staging_cloud_faces:', result);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('❌ Lỗi khi dọn dẹp staging_cloud_faces:', err);
    process.exit(1);
  });
}
