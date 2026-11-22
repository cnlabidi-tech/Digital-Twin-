/** PostgreSQL connection pool (node-postgres). */
import pg from 'pg';
import { config } from '../config';

// Return BIGINT (int8) columns as JS numbers: our counters fit in 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ ...config.db, max: 10 });

export async function waitForDb(retries = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
