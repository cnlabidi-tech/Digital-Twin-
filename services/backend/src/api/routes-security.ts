/**
 * Security endpoints (Phase 6).
 *   GET  /api/security/status        mode, gate counters, rejected-by-reason   (viewer)
 *   GET  /api/audit?limit=           audit log                                 (admin)
 *   GET  /api/audit/verify           recompute the hash chain                  (admin)
 *   GET  /api/users                  list users                                (admin)
 *   POST /api/users                  { username, password, role }              (admin)
 *   POST /api/users/me/password      { current, next }                         (any logged-in user)
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { pool } from '../db/pool';
import { stats as ingestStats } from '../ingestion/handler';
import type { AuditLog } from '../security/audit';
import { hashPassword, verifyPassword, type Role } from '../security/auth';
import type { GateStats } from '../security/gate';

export async function securityRoutes(app: FastifyInstance, opts: { audit: AuditLog; gateStats: GateStats }) {
  const admin = { config: { role: 'admin' } };

  app.get('/api/security/status', async () => ({
    mode: config.securityMode,
    signaturesRequired: config.security.requireSignatures,
    loginRequired: config.security.requireLogin,
    mqttTls: config.mqtt.url.startsWith('mqtts'),
    gate: opts.gateStats,
    rejected: ingestStats.rejected,
  }));

  app.get<{ Querystring: { limit?: string } }>('/api/audit', admin, async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    return (await pool.query('SELECT id, time, actor, role, ip, action, target, result, details, hash FROM audit_log ORDER BY id DESC LIMIT $1', [limit])).rows;
  });

  app.get('/api/audit/verify', admin, async () => opts.audit.verify());

  app.get('/api/users', admin, async () =>
    (await pool.query('SELECT username, role, created_at, last_login, disabled FROM users ORDER BY username')).rows);

  app.post<{ Body: { username?: string; password?: string; role?: Role } }>('/api/users', admin, async (req, reply) => {
    const { username = '', password = '', role = 'viewer' } = req.body ?? {};
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return reply.code(400).send({ error: 'username: 3-32 chars [a-z0-9_.-]' });
    if (password.length < 10) return reply.code(400).send({ error: 'password: at least 10 characters' });
    if (!['viewer', 'operator', 'admin'].includes(role)) return reply.code(400).send({ error: 'bad role' });
    await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)
       ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role`,
      [username, hashPassword(password), role],
    );
    await opts.audit.record({ actor: req.user.username, role: req.user.role, ip: req.ip, action: 'user.upsert', target: username, result: 'ok', details: { role } });
    return { ok: true };
  });

  app.post<{ Body: { current?: string; next?: string } }>('/api/users/me/password', { config: { role: 'viewer' } }, async (req, reply) => {
    const { current = '', next = '' } = req.body ?? {};
    if (next.length < 10) return reply.code(400).send({ error: 'new password: at least 10 characters' });
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE username=$1', [req.user.username]);
    if (!rows[0] || !verifyPassword(current, rows[0].password_hash)) {
      await opts.audit.record({ actor: req.user.username, ip: req.ip, action: 'password.change', result: 'denied' });
      return reply.code(403).send({ error: 'current password is wrong' });
    }
    await pool.query('UPDATE users SET password_hash=$2 WHERE username=$1', [req.user.username, hashPassword(next)]);
    await opts.audit.record({ actor: req.user.username, ip: req.ip, action: 'password.change', result: 'ok' });
    return { ok: true };
  });
}
