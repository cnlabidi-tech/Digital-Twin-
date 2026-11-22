/**
 * Backend entry point: wires the modules together.
 *
 *   MQTT --> ingestion/handler --bus--> ingestion/writer --> TimescaleDB
 *                                  \--> (Phase 3) WebSocket, (Phase 4) twin ...
 *   Fastify HTTP API on API_HOST:API_PORT
 */
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { topicAll } from '@twin/contracts';
import { dataRoutes } from './api/routes-data';
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

  const writer = new StorageWriter(log);
  writer.start();

  const mqtt = connectMqtt(log);
  mqtt.on('connect', () => {
    mqtt.subscribe([topicAll('telemetry'), topicAll('status'), topicAll('ack')], { qos: 1 });
  });
  mqtt.on('message', (topic, payload) => handleMessage(topic, payload));

  await app.register(cors, { origin: config.api.corsOrigin });
  app.get('/api/health', async () => ({
    ok: true,
    mqtt: mqtt.connected,
    ingestion: { ...stats, written: writer.written, storageErrors: writer.errors },
  }));
  await app.register(dataRoutes);
  await app.listen({ host: config.api.host, port: config.api.port });

  const shutdown = async () => {
    log.info('shutting down');
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
