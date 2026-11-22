/**
 * Alerts and event-history endpoints (Phase 3).
 *
 *   GET  /api/alerts?state=open|all&limit=100
 *   POST /api/alerts/:id/ack            { by? }   (user identity from login in Phase 6)
 *   GET  /api/events?kind=&limit=200&before=
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool';
import type { AlertService } from '../alerts/service';

export async function alertRoutes(app: FastifyInstance, opts: { alerts: AlertService }) {
  app.get<{ Querystring: { state?: string; limit?: string } }>('/api/alerts', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const where = req.query.state === 'all' ? '' : "WHERE state <> 'resolved'";
    return (await pool.query(`SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
  });

  app.post<{ Params: { id: string }; Body: { by?: string } | undefined }>('/api/alerts/:id/ack', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    // Phase 6 replaces this with the authenticated user name.
    const by = (req as { user?: { username: string } }).user?.username ?? req.body?.by ?? 'operator';
    const a = await opts.alerts.acknowledge(id, by);
    return a ?? reply.code(404).send({ error: 'no active alert with this id' });
  });

  app.get<{ Querystring: { kind?: string; limit?: string; before?: string } }>('/api/events', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 2000);
    const params: unknown[] = [limit];
    const cond: string[] = [];
    if (req.query.kind) {
      params.push(req.query.kind.split(','));
      cond.push(`kind = ANY($${params.length})`);
    }
    if (req.query.before) {
      params.push(new Date(req.query.before));
      cond.push(`time < $${params.length}`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return (await pool.query(`SELECT * FROM events ${where} ORDER BY time DESC LIMIT $1`, params)).rows;
  });
}
