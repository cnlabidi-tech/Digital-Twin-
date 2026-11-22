/**
 * Backend entry point: wires the modules together.
 *
 *   MQTT(TLS) --> ingestion/handler --[security gate]--bus--> ingestion/writer --> TimescaleDB
 *                                                        |--> alerts/device-monitor --> alerts/events
 *                                                        |--> security/plausibility (FDI) --> alerts
 *                                                        |--> twin/engine (model, detection) --> alerts, twin_state
 *                                                        |--> api/ws (live dashboard, token required)
 *                                                        \--> control (acks, verification)
 *   twin 'loss_confirmed' --> control/supervisor --> commands (signed) --> MQTT cmd topic --> device
 *   Fastify HTTP API: JWT login, role guard, audit log. Built dashboard served at "/".
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { topicAll } from '@twin/contracts';
import { DeviceMonitor } from './alerts/device-monitor';
import { AlertService } from './alerts/service';
import { alertRoutes } from './api/routes-alerts';
import { controlRoutes } from './api/routes-control';
import { dataRoutes } from './api/routes-data';
import { securityRoutes } from './api/routes-security';
import { twinRoutes } from './api/routes-twin';
import { LiveState, wsRoutes } from './api/ws';
import { config } from './config';
import { CommandService } from './control/commands';
import { Supervisor } from './control/supervisor';
import { migrate } from './db/migrate';
import { pool, waitForDb } from './db/pool';
import { handleMessage, stats } from './ingestion/handler';
import { connectMqtt } from './ingestion/mqtt';
import { StorageWriter } from './ingestion/writer';
import { AuditLog } from './security/audit';
import { authPlugin, installGuard, seedUsers } from './security/auth';
import { setupSecurity } from './security/index';
import { TwinEngine } from './twin/engine';

const app = Fastify({ logger: { level: config.logLevel } });
const log = {
  info: (m: string) => app.log.info(m),
  warn: (m: string) => app.log.warn(m),
  error: (m: string) => app.log.error(m),
};

async function main() {
  await waitForDb();
  await migrate(log.info);
  await seedUsers(log);

  // --- modules (order matters: listeners must exist before MQTT delivers data)
  const audit = new AuditLog();
  const writer = new StorageWriter(log);
  writer.start();
  const alerts = new AlertService(log);
  await alerts.load();
  const monitor = new DeviceMonitor(alerts);
  monitor.start();
  const live = new LiveState();
  const twin = new TwinEngine(alerts, log);
  await twin.start();

  const mqtt = connectMqtt(log);
  const commands = new CommandService(mqtt, alerts, log);
  const security = setupSecurity({ alerts, commands, log });
  const supervisor = new Supervisor(commands, twin, alerts, audit);
  await supervisor.start();

  mqtt.on('connect', () => {
    mqtt.subscribe([topicAll('telemetry'), topicAll('status'), topicAll('ack')], { qos: 1 });
  });
  mqtt.on('message', (topic, payload) => handleMessage(topic, payload));

  // --- HTTP API
  await app.register(cors, { origin: config.api.corsOrigin });
  await app.register(authPlugin, { audit });
  installGuard(app, audit);
  const ws = await wsRoutes(app, { live, alerts });
  app.get('/api/health', async () => ({
    ok: true,
    mqtt: mqtt.connected,
    security: config.securityMode,
    wsClients: ws.clientCount(),
    ingestion: { ...stats, written: writer.written, storageErrors: writer.errors },
  }));
  await app.register(dataRoutes);
  await app.register(alertRoutes, { alerts, audit });
  await app.register(twinRoutes, { twin, audit });
  await app.register(controlRoutes, { supervisor, audit });
  await app.register(securityRoutes, { audit, gateStats: security.stats });

  const dashboard = resolve(import.meta.dirname, '../../../apps/dashboard/dist');
  if (existsSync(dashboard)) {
    await app.register(fastifyStatic, { root: dashboard });
    // single-page app: unknown non-API paths return index.html
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  await app.listen({ host: config.api.host, port: config.api.port });
  void alerts.event('system', 'info', `Backend started (security mode: ${config.securityMode})`);
  void audit.record({ actor: 'system', action: 'startup', result: 'ok', details: { securityMode: config.securityMode } });

  const shutdown = async () => {
    log.info('shutting down');
    monitor.stop();
    await app.close();
    await writer.stop();
    await mqtt.endAsync();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
