/**
 * Tamper-evident audit log (hash chain).
 *
 *   hash_n = SHA-256( hash_{n-1} | time | actor | action | target | result | details )
 *
 * Who did what, when, from where, and with which result. Rows can only be
 * appended (a database trigger blocks UPDATE/DELETE); if someone with direct
 * database access still alters a row, the chain no longer verifies.
 */
import { createHash } from 'node:crypto';
import { pool } from '../db/pool';

export interface AuditEntry {
  actor: string;
  role?: string;
  ip?: string;
  action: string;
  target?: string;
  result: 'ok' | 'denied' | 'error';
  details?: unknown;
}

const GENESIS = '0'.repeat(64);

/**
 * Canonical JSON (keys sorted recursively). Needed because PostgreSQL jsonb
 * does not preserve key order: the hash must not depend on it.
 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

function digest(prev: string, time: string, e: AuditEntry): string {
  const body = [prev, time, e.actor, e.role ?? '', e.ip ?? '', e.action, e.target ?? '', e.result, canonical(e.details ?? null)].join('|');
  return createHash('sha256').update(body).digest('hex');
}

export class AuditLog {
  private chain: Promise<unknown> = Promise.resolve();

  /** Append an entry. Calls are serialised so the chain is never forked. */
  record(e: AuditEntry): Promise<void> {
    const next = this.chain.then(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
        const { rows } = await client.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
        const prev = rows[0]?.hash ?? GENESIS;
        const time = new Date().toISOString();
        const hash = digest(prev, time, e);
        await client.query(
          `INSERT INTO audit_log (time, actor, role, ip, action, target, result, details, prev_hash, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [time, e.actor, e.role ?? null, e.ip ?? null, e.action, e.target ?? null, e.result, JSON.stringify(e.details ?? null), prev, hash],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('audit write failed', err);
      } finally {
        client.release();
      }
    });
    this.chain = next;
    return next;
  }

  /** Recompute the whole chain. Returns the first broken row, if any. */
  async verify(): Promise<{ ok: boolean; rows: number; brokenAt?: number }> {
    const { rows } = await pool.query(
      'SELECT id, time, actor, role, ip, action, target, result, details, prev_hash, hash FROM audit_log ORDER BY id',
    );
    let prev = GENESIS;
    for (const r of rows) {
      const time = new Date(r.time).toISOString();
      const h = digest(prev, time, { actor: r.actor, role: r.role ?? undefined, ip: r.ip ?? undefined, action: r.action, target: r.target ?? undefined, result: r.result, details: r.details });
      if (r.prev_hash !== prev || r.hash !== h) return { ok: false, rows: rows.length, brokenAt: Number(r.id) };
      prev = r.hash;
    }
    return { ok: true, rows: rows.length };
  }
}
