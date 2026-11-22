/**
 * Control endpoints (Phase 5).
 *   POST /api/commands        { deviceId, type, params, force? }   send a command
 *   GET  /api/commands?limit= recent commands with status / latency / verification
 *   GET  /api/control/policy
 *   PUT  /api/control/policy  { autoStopOnLeak?, autoStopOnTheft? }
 */
import type { FastifyInstance } from 'fastify';
import { COMMAND_TYPES, DEVICE_IDS, type CommandType, type DeviceId } from '@twin/contracts';
import { pool } from '../db/pool';
import type { Supervisor } from '../control/supervisor';

type CmdBody = { deviceId: DeviceId; type: CommandType; params?: Record<string, unknown>; force?: boolean };

const username = (req: unknown) => (req as { user?: { username: string } }).user?.username ?? 'operator';

export async function controlRoutes(app: FastifyInstance, opts: { supervisor: Supervisor }) {
  app.post<{ Body: CmdBody }>('/api/commands', async (req, reply) => {
    const b = req.body ?? ({} as CmdBody);
    if (!DEVICE_IDS.includes(b.deviceId)) return reply.code(400).send({ error: 'unknown deviceId' });
    if (!COMMAND_TYPES.includes(b.type)) return reply.code(400).send({ error: 'unknown command type' });
    try {
      return await opts.supervisor.manual(b.deviceId, b.type, b.params ?? {}, username(req), b.force === true);
    } catch (e) {
      return reply.code((e as { status?: number }).status ?? 500).send({ error: (e as Error).message });
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/commands', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    return (await pool.query('SELECT * FROM commands ORDER BY created_at DESC LIMIT $1', [limit])).rows;
  });

  app.get('/api/control/policy', async () => opts.supervisor.policy);

  app.put<{ Body: { autoStopOnLeak?: boolean; autoStopOnTheft?: boolean } }>('/api/control/policy', async (req, reply) => {
    const b = req.body ?? {};
    const p: Record<string, boolean> = {};
    for (const k of ['autoStopOnLeak', 'autoStopOnTheft'] as const) {
      if (b[k] !== undefined) {
        if (typeof b[k] !== 'boolean') return reply.code(400).send({ error: `${k} must be boolean` });
        p[k] = b[k]!;
      }
    }
    return opts.supervisor.setPolicy(p, username(req));
  });
}
