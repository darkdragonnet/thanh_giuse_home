import pg from 'pg';
import type { DbConfig } from './types.js';

const { Pool } = pg;

export function createDbPool(config: DbConfig): pg.Pool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
  });

  pool.on('error', (err) => {
    console.error('[DB POOL ERROR]', err);
  });

  return pool;
}

export async function closeDbPool(pool: pg.Pool): Promise<void> {
  await pool.end();
}

export async function checkDbConnection(pool: pg.Pool): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 as connected');
    return res.rows[0]?.connected === 1;
  } catch (error) {
    console.error('[DB HEALTHCHECK FAILED]', error);
    return false;
  }
}
