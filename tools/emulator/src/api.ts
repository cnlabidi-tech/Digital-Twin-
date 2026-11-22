/**
 * Local HTTP control API of the emulator (development tool, no auth - bind to
 * localhost only). Lets a test, a scenario file, curl or the dashboard's dev
 * panel inject leaks, theft, faults and attacks.
 *
 *   GET    /api/state                      plant truth + active injections
 *   POST   /api/leak     {segment,fraction,rateLpm,rampS}
 *   POST   /api/theft    {segment,fraction,rateLpm,rampS}
 *   DELETE /api/taps/:id | /api/taps       stop one / all leaks and thefts
 *   POST   /api/valve    {outletOpening}   normal operating change (no alarm expected)
 *   POST   /api/pump     {on,duty}         local pump switch
 *   POST   /api/faults   {sensor,type,magnitude}
 *   DELETE /api/faults/:id
 *   POST   /api/attacks  {type,sensor|device,...}
 *   DELETE /api/attacks/:id
 *   POST   /api/devices/:id/offline {seconds}
 *   POST   /api/reset
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DeviceId, SensorId } from '@twin/contracts';
import type { AttackSpec } from './attacks';
import type { Emulator, TapRequest } from './emulator';
import type { FaultType } from './plant';

type Handler = (body: Record<string, unknown>, params: string[]) => unknown;

export function startApi(emu: Emulator, port: number, host = '127.0.0.1') {
  const routes: Array<[string, RegExp, Handler]> = [
    ['GET', /^\/api\/state$/, () => emu.state()],
    ['POST', /^\/api\/leak$/, (b) => emu.addTap({ ...(b as Partial<TapRequest>), kind: 'leak' })],
    ['POST', /^\/api\/theft$/, (b) => emu.addTap({ ...(b as Partial<TapRequest>), kind: 'theft' })],
    ['DELETE', /^\/api\/taps$/, () => [...emu.plant.taps.keys()].map((id) => emu.removeTap(id)).length],
    ['DELETE', /^\/api\/taps\/([\w-]+)$/, (_b, [id]) => found(emu.removeTap(id!))],
    ['POST', /^\/api\/valve$/, (b) => (emu.setValve(Number(b.outletOpening)), emu.state().truth)],
    ['POST', /^\/api\/pump$/, (b) => (emu.setPump(Boolean(b.on), b.duty === undefined ? undefined : Number(b.duty)), emu.state().truth)],
    ['POST', /^\/api\/faults$/, (b) => ({ id: emu.addFault(b.sensor as SensorId, b.type as FaultType, b.magnitude as number | undefined) })],
    ['DELETE', /^\/api\/faults\/([\w-]+)$/, (_b, [id]) => found(emu.removeFault(id!))],
    ['POST', /^\/api\/attacks$/, (b) => {
      const { recorded, recordedRaw, fakePulses, frozen, ...a } = emu.addAttack(b as unknown as AttackSpec);
      return a;
    }],
    ['DELETE', /^\/api\/attacks\/([\w-]+)$/, (_b, [id]) => found(emu.removeAttack(id!))],
    ['POST', /^\/api\/devices\/([\w-]+)\/offline$/, (b, [id]) => (emu.deviceOffline(id as DeviceId, Number(b.seconds ?? 20)), { ok: true })],
    ['POST', /^\/api\/reset$/, () => (emu.reset(), { ok: true })],
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Permissive CORS: the dashboard dev panel (another localhost port) may call this.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const path = (req.url ?? '/').split('?')[0]!;
    const route = routes.find(([m, re]) => m === req.method && re.test(path));
    if (!route) return send(res, 404, { error: 'not found' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const params = route[1].exec(path)!.slice(1);
      send(res, 200, route[2](body, params) ?? { ok: true });
    } catch (e) {
      send(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
    }
  });
  server.listen(port, host, () => console.log(`[emulator] control API on http://${host}:${port}/api/state`));
  return server;
}

function found(ok: boolean) {
  if (!ok) throw Object.assign(new Error('not found'), { status: 404 });
  return { ok: true };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new Error('body too large');
  }
  if (!data) return {};
  const v = JSON.parse(data);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('body must be a JSON object');
  return v;
}
