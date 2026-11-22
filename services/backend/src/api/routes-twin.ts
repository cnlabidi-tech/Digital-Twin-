/**
 * Twin endpoints (Phase 4).
 *   GET  /api/twin                     current twin state + model
 *   POST /api/twin/relearn             learn a new healthy baseline (admin)
 *   GET  /api/twin/history?from=&to=   1 Hz residual / diagnosis history
 *   GET  /api/twin/models              learned models (audit of re-learning)
 *   GET  /api/twin/commissioning       sanity checks of the learned model (Phase 8)
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool';
import type { AuditLog } from '../security/audit';
import type { TwinEngine } from '../twin/engine';
import type { ModelParams } from '../twin/model';

export async function twinRoutes(app: FastifyInstance, opts: { twin: TwinEngine; audit: AuditLog }) {
  app.get('/api/twin', async () => ({ state: opts.twin.last, params: opts.twin.core.params }));

  app.post('/api/twin/relearn', { config: { role: 'admin' } }, async (req) => {
    const by = req.user?.username ?? 'admin';
    await opts.twin.relearn(by);
    await opts.audit.record({ actor: by, role: req.user?.role, ip: req.ip, action: 'twin.relearn', result: 'ok' });
    return { ok: true };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/twin/history', async (req) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 15 * 60_000);
    return (await pool.query('SELECT * FROM twin_state WHERE time BETWEEN $1 AND $2 ORDER BY time LIMIT 50000', [from, to])).rows;
  });

  app.get('/api/twin/commissioning', async () => commissioning(opts.twin.core.params));

  app.get('/api/twin/models', async () => (await pool.query('SELECT * FROM twin_model ORDER BY created_at DESC LIMIT 20')).rows);
}

/**
 * Commissioning checks on the model learned from the real rig: are the
 * identified parameters physically sensible, and what can the twin detect?
 */
export function commissioning(p: ModelParams | null) {
  if (!p) return { ready: false, checks: [{ level: 'FAIL', check: 'model learned', detail: 'no model: start the pump and keep the pipe healthy 60 s' }] };
  const checks: Array<{ level: 'PASS' | 'WARN' | 'FAIL'; check: string; detail: string }> = [];
  const add = (ok: boolean, warnOnly: boolean, check: string, detail: string) => checks.push({ level: ok ? 'PASS' : warnOnly ? 'WARN' : 'FAIL', check, detail });
  add(p.RA > 0 && p.RB > 0, false, 'segment resistances positive', `RA=${p.RA.toFixed(4)}, RB=${p.RB.toFixed(4)} bar/(L/min)^2 (negative = sensor order or zero offsets wrong)`);
  add(p.Rout > 0, false, 'outlet resistance positive', `Rout=${p.Rout.toFixed(4)}`);
  add(p.c > 0.9 && p.c < 1.1, true, 'flow meters agree (ratio c)', `c=F1/F2=${p.c.toFixed(3)} (outside 0.9-1.1: calibrate the K-factors)`);
  add(p.pumpA > 4 && p.pumpA < 10, true, 'pump curve plausible', `shut-off ${p.pumpA.toFixed(2)} bar (datasheet 8 bar)`);
  add(p.sigma.mass < 0.1, true, 'mass-balance noise', `sigma=${p.sigma.mass.toFixed(3)} L/min`);
  const minLeak = 5 * p.sigma.mass;
  const dropA = p.RA * p.nominal.F1 ** 2;
  const dropB = p.RB * p.nominal.F1 ** 2;
  add(dropA > 10 * p.sigma.segA && dropB > 10 * p.sigma.segB, true, 'pressure drop per segment measurable',
    `A: ${dropA.toFixed(3)} bar, B: ${dropB.toFixed(3)} bar at ${p.nominal.F1.toFixed(2)} L/min (small drops => poor localisation)`);
  return {
    ready: !checks.some((c) => c.level === 'FAIL'),
    nominal: p.nominal,
    detection: {
      minLeakFastLpm: +minLeak.toFixed(3),
      minLeakFastPercent: +((100 * minLeak) / p.nominal.F1).toFixed(1),
      note: 'leaks above this are detected within ~3 s (threshold); smaller persistent leaks by CUSUM within tens of seconds',
    },
    checks,
  };
}
