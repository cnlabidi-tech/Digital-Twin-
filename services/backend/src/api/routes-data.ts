/**
 * Read-only data endpoints (Phase 2). Used by the dashboard for history and
 * by tests to verify ingestion.
 *
 *   GET /api/devices                         device registry + online state
 *   GET /api/telemetry/latest                last value of every sensor
 *   GET /api/telemetry?sensor=P1&from=&to=&bucket=   history of one or more sensors
 *   GET /api/rejected?limit=50               last rejected messages
 */
import type { FastifyInstance } from 'fastify';
import { SENSOR_IDS } from '@twin/contracts';
import { pool } from '../db/pool';

const BUCKETS: Record<string, string> = { raw: '', '1s': '1 second', '5s': '5 seconds', '1m': '1 minute', '10m': '10 minutes' };

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/devices', async () => (await pool.query('SELECT * FROM devices ORDER BY device_id')).rows);

  app.get('/api/telemetry/latest', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (sensor_id) sensor_id, device_id, time, value, raw, quality
         FROM sensor_readings WHERE time > now() - INTERVAL '1 hour'
         ORDER BY sensor_id, time DESC`,
    );
    return rows;
  });

  app.get<{ Querystring: { sensor?: string; from?: string; to?: string; bucket?: string; limit?: string } }>(
    '/api/telemetry',
    async (req, reply) => {
      const sensors = (req.query.sensor ?? SENSOR_IDS.join(',')).split(',');
      if (!sensors.every((s) => (SENSOR_IDS as readonly string[]).includes(s))) {
        return reply.code(400).send({ error: `sensor must be among ${SENSOR_IDS.join(',')}` });
      }
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 10 * 60_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return reply.code(400).send({ error: 'bad from/to' });
      const bucket = BUCKETS[req.query.bucket ?? 'raw'];
      if (bucket === undefined) return reply.code(400).send({ error: `bucket must be one of ${Object.keys(BUCKETS).join(',')}` });
      const limit = Math.min(Number(req.query.limit ?? 20000), 100000);
      const sql = bucket
        ? `SELECT time_bucket($4::interval, time) AS time, sensor_id, avg(value) AS value, min(value) AS min, max(value) AS max
             FROM sensor_readings WHERE sensor_id = ANY($1) AND time BETWEEN $2 AND $3
             GROUP BY 1, 2 ORDER BY 1 LIMIT $5`
        : `SELECT time, sensor_id, value, raw, quality FROM sensor_readings
             WHERE sensor_id = ANY($1) AND time BETWEEN $2 AND $3 ORDER BY time LIMIT $4`;
      const params = bucket ? [sensors, from, to, bucket, limit] : [sensors, from, to, limit];
      return (await pool.query(sql, params)).rows;
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/api/rejected', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    return (await pool.query('SELECT * FROM rejected_messages ORDER BY time DESC LIMIT $1', [limit])).rows;
  });
}
