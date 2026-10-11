import pg from 'pg';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATECHISM_GROUPS, SPECIAL_UNITS } from '@thanh-giuse/shared-types';

const { Pool } = pg;

const LEVELS = [1, 2, 3];
const SECTIONS = ['A', 'B', 'C'];

export async function seedCatechismClasses(pool: pg.Pool) {
  console.log('--- KHỞI TẠO 45 LỚP GIÁO LÝ & 7 BAN/GIỚI ---');

  // 1. Seed 45 Lớp Thiếu Nhi
  for (const g of CATECHISM_GROUPS) {
    for (const l of LEVELS) {
      for (const s of SECTIONS) {
        const code = `${g.code}${l}${s}`;
        const name = `Lớp ${g.name} ${l}${s}`;
        const token = `PIN_${code}_${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        await pool.query(
          `INSERT INTO classes (code, name, token, is_locked)
           VALUES ($1, $2, $3, false)
           ON CONFLICT (code) DO NOTHING`,
          [code, name, token]
        );
      }
    }
  }

  // 2. Seed 7 Ban/Giới
  for (const u of SPECIAL_UNITS) {
    const token = `PIN_${u.code}_${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (code) DO NOTHING`,
      [u.code, u.name, token]
    );
  }

  const res = await pool.query('SELECT COUNT(*)::int as total FROM classes');
  const count = res.rows[0]?.total ?? 0;
  console.log(`✅ SEED HOÀN TẤT: ĐÃ CÓ ${count} LỚP/BAN TRONG CƠ SỞ DỮ LIỆU`);
  return count;
}

// Chạy trực tiếp nếu là file chính (CLI execution)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

  const pool = new Pool({ connectionString });
  seedCatechismClasses(pool)
    .then(() => pool.end())
    .catch((err) => {
      console.error('❌ Lỗi seed classes:', err);
      pool.end().finally(() => process.exit(1));
    });
}
