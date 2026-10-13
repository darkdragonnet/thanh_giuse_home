import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  executeStage1SnapshotAndSeed,
  seedCatechismClasses,
  type ExcelSeedStudentInput,
  type CloudSnapshotFaceInput,
} from '@thanh-giuse/shared-infra';

const { Pool } = pg;

/**
 * CLI Giai đoạn 1: Nạp Snapshot HANET Cloud + Danh sách 1.200 học sinh Excel vào RAM trước,
 * sau đó thực thi Set-Based SQL Mapping & Auto-INSERT trong Transaction READ COMMITTED < 100ms.
 *
 * Cách dùng:
 *   npx tsx scripts/snapshot-and-seed-1200.ts --excel=./data/students-1200.json --snapshot=./data/cloud-snapshot.json
 */
async function main() {
  const args = process.argv.slice(2);
  const excelArg = args.find((a) => a.startsWith('--excel='))?.split('=')[1];
  const snapshotArg = args.find((a) => a.startsWith('--snapshot='))?.split('=')[1];

  // Đọc dữ liệu hoàn toàn vào RAM trước khi mở kết nối Transaction DB
  let excelStudents: ExcelSeedStudentInput[] = [];
  let cloudFaces: CloudSnapshotFaceInput[] = [];

  if (excelArg && fs.existsSync(path.resolve(excelArg))) {
    excelStudents = JSON.parse(fs.readFileSync(path.resolve(excelArg), 'utf8'));
  }
  if (snapshotArg && fs.existsSync(path.resolve(snapshotArg))) {
    cloudFaces = JSON.parse(fs.readFileSync(path.resolve(snapshotArg), 'utf8'));
  }

  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

  const pool = new Pool({ connectionString });
  try {
    await seedCatechismClasses(pool);
    const summary = await executeStage1SnapshotAndSeed(pool, excelStudents, cloudFaces);
    console.log('✅ GIAI ĐOẠN 1 HOÀN TẤT:', JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('❌ Lỗi khi chạy snapshot-and-seed-1200:', err);
    process.exit(1);
  });
}
