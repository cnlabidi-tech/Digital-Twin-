/**
 * Storage writer: listens on the bus and writes to TimescaleDB.
 * Telemetry is buffered and written in batches (one multi-row INSERT per
 * table). At 2 devices x 2 Hz this is light, but batching keeps the design
 * valid if the sampling rate is raised.
 */
import type { Status, Telemetry } from '@twin/contracts';
import { bus, type Received, type Rejection } from '../bus';
import { config } from '../config';
import { pool } from '../db/pool';

type Log = { info: (m: string) => void; error: (m: string) => void };

/** Build "($1,$2,...),($n,...)" placeholders for a multi-row INSERT. */
export function placeholders(rows: unknown[][]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const groups = rows.map((r) => {
    const ph = r.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${ph.join(',')})`;
  });
  return { sql: groups.join(','), params };
}

/** Map one telemetry message to table rows (pure function, unit-tested). */
export function telemetryRows(r: Received<Telemetry>) {
  const m = r.msg;
  const time = new Date(m.ts);
  const p = m.actuators?.pump;
  const message = [time, new Date(r.receivedAt), m.deviceId, m.bootId, m.seq, m.nonce, m.intervalMs,
    p?.on ?? null, p?.duty ?? null, m.diag.rssi, m.diag.uptimeS, m.diag.heapFree, m.diag.ntpSynced, r.signed];
  const readings = Object.entries(m.sensors).map(([sensorId, s]) => [time, m.deviceId, sensorId, s.v, s.raw, s.q]);
  return { message, readings };
}

export class StorageWriter {
  private buffer: Array<Received<Telemetry>> = [];
  private timer?: NodeJS.Timeout;
  written = 0;
  errors = 0;

  constructor(private readonly log: Log) {}

  start(): void {
    bus.on('telemetry', (r) => {
      this.buffer.push(r);
      if (this.buffer.length >= config.ingestion.maxBatch) void this.flush();
    });
    bus.on('status', (r) => void this.writeStatus(r).catch((e) => this.fail('status', e)));
    bus.on('rejected', (r) => void this.writeRejected(r).catch((e) => this.fail('rejected', e)));
    this.timer = setInterval(() => void this.flush(), config.ingestion.flushMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private fail(what: string, e: unknown) {
    this.errors++;
    this.log.error(`storage error (${what}): ${(e as Error).message}`);
  }

  async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    const messages: unknown[][] = [];
    const readings: unknown[][] = [];
    const lastSeen = new Map<string, number>();
    for (const r of batch) {
      const rows = telemetryRows(r);
      messages.push(rows.message);
      readings.push(...rows.readings);
      lastSeen.set(r.msg.deviceId, Math.max(lastSeen.get(r.msg.deviceId) ?? 0, r.receivedAt));
    }
    const m = placeholders(messages);
    const s = placeholders(readings);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO telemetry_messages (time, received_at, device_id, boot_id, seq, nonce, interval_ms,
           pump_on, pump_duty, rssi, uptime_s, heap_free, ntp_synced, signed) VALUES ${m.sql}`,
        m.params,
      );
      if (readings.length) {
        await client.query(`INSERT INTO sensor_readings (time, device_id, sensor_id, value, raw, quality) VALUES ${s.sql}`, s.params);
      }
      for (const [dev, at] of lastSeen) {
        await client.query('UPDATE devices SET last_seen = $2 WHERE device_id = $1', [dev, new Date(at)]);
      }
      await client.query('COMMIT');
      this.written += batch.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.fail('telemetry batch', e);
    } finally {
      client.release();
    }
  }

  private async writeStatus({ msg: s, receivedAt }: Received<Status>): Promise<void> {
    const at = new Date(receivedAt);
    await pool.query(
      'INSERT INTO device_status_log (time, device_id, online, reason, boot_id, fw) VALUES ($1,$2,$3,$4,$5,$6)',
      [at, s.deviceId, s.online, s.reason ?? null, s.bootId ?? null, s.fw ?? null],
    );
    await pool.query(
      `UPDATE devices SET online=$2, status_reason=$3, last_status=$4,
         boot_id=COALESCE($5, boot_id), fw=COALESCE($6, fw) WHERE device_id=$1`,
      [s.deviceId, s.online, s.reason ?? null, at, s.bootId ?? null, s.fw ?? null],
    );
  }

  private async writeRejected(r: Rejection): Promise<void> {
    await pool.query(
      'INSERT INTO rejected_messages (time, topic, device_id, channel, reason, details, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [new Date(r.time), r.topic, r.deviceId ?? null, r.channel ?? null, r.reason,
        r.details === undefined ? null : JSON.stringify(r.details), r.raw?.slice(0, 2048) ?? null],
    );
  }
}
