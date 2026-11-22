/**
 * Control endpoints (Phase 5).
 *   POST /api/commands        { deviceId, type, params, force? }   send a command
 *   GET  /api/commands?limit= recent commands with status / latency / verification
 *   GET  /api/control/policy
 *   PUT  /api/control/policy  { autoStopOnLeak?, autoStopOnTheft? }   (admin)
 * force=true (interlock override) requires admin. Every call is audited.
 */
import type { FastifyInstance } from 'fastify';
import { COMMAND_TYPES, DEVICE_IDS, type CommandType, type DeviceId } from '@twin/contracts';
import { pool } from '../db/pool';
import type { Supervisor } from '../control/supervisor';
import type { AuditLog } from '../security/audit';

type CmdBody = { deviceId: DeviceId; type: CommandType; params?: Record<string, unknown>; force?: boolean };


export async function controlRoutes(app: FastifyInstance, opts: { supervisor: Supervisor; audit: AuditLog }) {
  app.post<{ Body: CmdBody }>('/api/commands', async (req, reply) => {
    const b = req.body ?? ({} as CmdBody);
    if (!DEVICE_IDS.includes(b.deviceId)) return reply.code(400).send({ error: 'unknown deviceId' });
    if (!COMMAND_TYPES.includes(b.type)) return reply.code(400).send({ error: 'unknown command type' });
    const user = req.user?.username ?? 'operator';
    const force = b.force === true;
    const entry = { actor: user, role: req.user?.role, ip: req.ip, action: 'command', target: `${b.deviceId}:${b.type}`, details: { params: b.params ?? {}, force } };
    if (force && req.user?.role !== 'admin') {
      await opts.audit.record({ ...entry, result: 'denied', details: { ...entry.details, reason: 'override requires admin' } });
      return reply.code(403).send({ error: 'overriding an interlock requires the admin role' });
    }
    try {
      const rec = await opts.supervisor.manual(b.deviceId, b.type, b.params ?? {}, user, force);
      await opts.audit.record({ ...entry, result: 'ok', details: { ...entry.details, cmdId: rec.cmdId } });
      return rec;
    } catch (e) {
      await opts.audit.record({ ...entry, result: 'denied', details: { ...entry.details, reason: (e as Error).message } });
      return reply.code((e as { status?: number }).status ?? 500).send({ error: (e as Error).message });
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/commands', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    return (await pool.query('SELECT * FROM commands ORDER BY created_at DESC LIMIT $1', [limit])).rows;
  });

  app.get('/api/control/policy', async () => opts.supervisor.policy);

  app.put<{ Body: { autoStopOnLeak?: boolean; autoStopOnTheft?: boolean } }>('/api/control/policy', { config: { role: 'admin' } }, async (req, reply) => {
    const b = req.body ?? {};
    const p: Record<string, boolean> = {};
    for (const k of ['autoStopOnLeak', 'autoStopOnTheft'] as const) {
      if (b[k] !== undefined) {
        if (typeof b[k] !== 'boolean') return reply.code(400).send({ error: `${k} must be boolean` });
        p[k] = b[k]!;
      }
    }
    const user = req.user?.username ?? 'admin';
    await opts.audit.record({ actor: user, role: req.user?.role, ip: req.ip, action: 'policy.update', result: 'ok', details: p });
    return opts.supervisor.setPolicy(p, user);
  });
}
