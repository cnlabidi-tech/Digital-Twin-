/**
 * Twin endpoints (Phase 4).
 *   GET  /api/twin                     current twin state + model
 *   POST /api/twin/relearn             learn a new healthy baseline (operator/admin)
 *   GET  /api/twin/history?from=&to=   1 Hz residual / diagnosis history
 *   GET  /api/twin/models              learned models (audit of re-learning)
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool';
import type { TwinEngine } from '../twin/engine';

export async function twinRoutes(app: FastifyInstance, opts: { twin: TwinEngine }) {
  app.get('/api/twin', async () => ({ state: opts.twin.last, params: opts.twin.core.params }));

  app.post('/api/twin/relearn', async (req) => {
    const by = (req as { user?: { username: string } }).user?.username ?? 'operator';
    await opts.twin.relearn(by);
    return { ok: true };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/twin/history', async (req) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 15 * 60_000);
    return (await pool.query('SELECT * FROM twin_state WHERE time BETWEEN $1 AND $2 ORDER BY time LIMIT 50000', [from, to])).rows;
  });

  app.get('/api/twin/models', async () => (await pool.query('SELECT * FROM twin_model ORDER BY created_at DESC LIMIT 20')).rows);
}
