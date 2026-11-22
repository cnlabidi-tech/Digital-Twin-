/**
 * Backend configuration, read once from environment variables (12-factor).
 * Defaults match docker-compose.yml so `npm start` works on a dev laptop.
 */
const env = process.env;
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  mqtt: {
    url: env.MQTT_URL ?? 'mqtt://localhost:1883',
    username: env.MQTT_USERNAME || undefined,
    password: env.MQTT_PASSWORD || undefined,
    caFile: env.MQTT_CA_FILE || undefined,
    clientId: env.MQTT_CLIENT_ID ?? `twin-backend-${process.pid}`,
  },
  db: {
    host: env.POSTGRES_HOST ?? 'localhost',
    port: num(env.POSTGRES_PORT, 5432),
    user: env.POSTGRES_USER ?? 'twin',
    password: env.POSTGRES_PASSWORD ?? 'change-me-dev-only',
    database: env.POSTGRES_DB ?? 'pipeline_twin',
  },
  api: {
    host: env.API_HOST ?? '127.0.0.1',
    port: num(env.API_PORT, 4000),
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
  },
  ingestion: {
    /** Flush buffered rows at least this often (ms) ... */
    flushMs: num(env.INGEST_FLUSH_MS, 1000),
    /** ... or as soon as this many messages are buffered. */
    maxBatch: num(env.INGEST_MAX_BATCH, 200),
  },
  logLevel: env.LOG_LEVEL ?? 'info',
};
export type Config = typeof config;
