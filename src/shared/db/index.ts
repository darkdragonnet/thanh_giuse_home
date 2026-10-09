import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Giới hạn connection pool tối đa 10 connections để không vượt trần 40 max_connections của Postgres trên VPS 3GB
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DATABASE POOL ERROR] Sự cố kết nối ngoài ý muốn:', err);
});

export async function checkDbConnection(): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 as connected');
    return res.rows[0]?.connected === 1;
  } catch (error) {
    console.error('[DATABASE HEALTHCHECK FAILED]:', error);
    return false;
  }
}
