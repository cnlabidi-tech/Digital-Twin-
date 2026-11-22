/**
 * WebSocket gateway (/ws): pushes everything the dashboard needs, live.
 *
 * Server -> client messages (JSON):
 *   { type: "snapshot", latest, devices, alerts, twin }   once, on connect
 *   { type: "telemetry", data }   every accepted telemetry message (compact form)
 *   { type: "status", data }      device online/offline
 *   { type: "alert", data }       alert opened / updated / resolved
 *   { type: "event", data }       new history entry
 *   { type: "twin", data }        twin state (Phase 4)
 *   { type: "command", data }     command lifecycle (Phase 5)
 *   { type: "ack", data }         device acknowledgement
 * The channel is read-only: actions go through authenticated REST calls.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { DeviceId, Status, Telemetry } from '@twin/contracts';
import { bus } from '../bus';
import type { AlertService } from '../alerts/service';

/** Compact telemetry form sent to browsers (no nonce/signature noise). */
export function compactTelemetry(m: Telemetry, receivedAt: number) {
  return {
    deviceId: m.deviceId,
    ts: m.ts,
    receivedAt,
    seq: m.seq,
    sensors: Object.fromEntries(Object.entries(m.sensors).map(([k, r]) => [k, { v: r.v, q: r.q }])),
    pump: m.actuators?.pump,
    rssi: m.diag.rssi,
  };
}

export class LiveState {
  latest: Partial<Record<DeviceId, ReturnType<typeof compactTelemetry>>> = {};
  status: Partial<Record<DeviceId, Status & { receivedAt: number }>> = {};
  twin: unknown = null;

  constructor() {
    bus.on('telemetry', ({ msg, receivedAt }) => (this.latest[msg.deviceId] = compactTelemetry(msg, receivedAt)));
    bus.on('status', ({ msg, receivedAt }) => (this.status[msg.deviceId] = { ...msg, receivedAt }));
    bus.on('twin', (t) => (this.twin = t));
  }
}

export async function wsRoutes(app: FastifyInstance, opts: { live: LiveState; alerts: AlertService }) {
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const clients = new Set<WebSocket>();

  const broadcast = (type: string, data: unknown) => {
    const text = JSON.stringify({ type, data });
    for (const ws of clients) {
      // Slow client protection: skip messages if its send buffer is backing up.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) ws.send(text);
    }
  };

  bus.on('telemetry', ({ msg, receivedAt }) => broadcast('telemetry', compactTelemetry(msg, receivedAt)));
  bus.on('status', ({ msg, receivedAt }) => broadcast('status', { ...msg, receivedAt }));
  bus.on('ack', ({ msg }) => broadcast('ack', msg));
  bus.on('alert', (a) => broadcast('alert', a));
  bus.on('event', (e) => broadcast('event', e));
  bus.on('twin', (t) => broadcast('twin', t));
  bus.on('command', (c) => broadcast('command', c));

  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({
      type: 'snapshot',
      data: { latest: opts.live.latest, devices: opts.live.status, alerts: opts.alerts.openAlerts(), twin: opts.live.twin },
    }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  return { clientCount: () => clients.size };
}
