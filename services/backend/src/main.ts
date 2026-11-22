/**
 * Backend entry point: wires the modules together.
 *
 *   MQTT --> ingestion/handler --bus--> ingestion/writer --> TimescaleDB
 *                                  |--> alerts/device-monitor --> alerts/events
 *                                  \--> api/ws (live dashboard)
 *   Fastify HTTP API + WebSocket on API_HOST:API_PORT
 *   In production the built dashboard (apps/dashboard/dist) is served at "/".
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
import { dataRoutes } from './api/routes-data';
import { LiveState, wsRoutes } from './api/ws';
import { config } from './config';
import { migrate } from './db/migrate';
import { pool, waitForDb } from './db/pool';
import { handleMessage, stats } from './ingestion/handler';
import { connectMqtt } from './ingestion/mqtt';
import { StorageWriter } from './ingestion/writer';

const app = Fastify({ logger: { level: config.logLevel } });
const log = {
  info: (m: string) => app.log.info(m),
  warn: (m: string) => app.log.warn(m),
  error: (m: string) => app.log.error(m),
};

async function main() {
  await waitForDb();
  await migrate(log.info);

  // --- modules (order matters: listeners must exist before MQTT delivers data)
  const writer = new StorageWriter(log);
  writer.start();
  const alerts = new AlertService(log);
  await alerts.load();
  const monitor = new DeviceMonitor(alerts);
  monitor.start();
  const live = new LiveState();

  const mqtt = connectMqtt(log);
  mqtt.on('connect', () => {
    mqtt.subscribe([topicAll('telemetry'), topicAll('status'), topicAll('ack')], { qos: 1 });
  });
  mqtt.on('message', (topic, payload) => handleMessage(topic, payload));

  // --- HTTP API
  await app.register(cors, { origin: config.api.corsOrigin });
  const ws = await wsRoutes(app, { live, alerts });
  app.get('/api/health', async () => ({
    ok: true,
    mqtt: mqtt.connected,
    wsClients: ws.clientCount(),
    ingestion: { ...stats, written: writer.written, storageErrors: writer.errors },
  }));
  await app.register(dataRoutes);
  await app.register(alertRoutes, { alerts });

  const dashboard = resolve(import.meta.dirname, '../../../apps/dashboard/dist');
  if (existsSync(dashboard)) {
    await app.register(fastifyStatic, { root: dashboard });
    // single-page app: unknown non-API paths return index.html
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  await app.listen({ host: config.api.host, port: config.api.port });
  void alerts.event('system', 'info', 'Backend started');

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
