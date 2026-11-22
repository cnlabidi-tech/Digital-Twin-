/**
 * Minimal migration runner: applies every *.sql file in ./migrations in name
 * order, exactly once, each in a transaction. Applied files are recorded in
 * schema_migrations. Runs automatically at backend start-up.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool, waitForDb } from './pool';

const DIR = resolve(import.meta.dirname, 'migrations');

export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(resolve(DIR, file), 'utf8');
    // TimescaleDB continuous aggregates cannot be created inside a transaction:
    // files containing "-- no-transaction" run statement by statement.
    const client = await pool.connect();
    try {
      if (sql.includes('-- no-transaction')) {
        for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await client.query(stmt);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      } else {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      }
      log(`migration applied: ${file}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
}

// Allow `npm run migrate` from the command line.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  waitForDb().then(() => migrate()).then(() => pool.end(), (e) => { console.error(e); process.exit(1); });
}
