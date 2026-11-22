/**
 * Alerts and events.
 *
 * - `raise(key, ...)`   opens an alert, or refreshes it if one with the same
 *                       key is already open (no alert storms).
 * - `resolve(key)`      closes it when the condition disappears.
 * - `acknowledge(id)`   operator has seen it (stays open until resolved).
 * - `event(...)`        append-only history entry.
 * Every change is published on the bus so the dashboard updates live.
 */
import { pool } from '../db/pool';
import { bus } from '../bus';

export type AlertType = 'leak' | 'theft' | 'fdi' | 'sensor_fault' | 'device_offline' | 'security' | 'model';
export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: number;
  key: string;
  type: AlertType;
  severity: Severity;
  state: 'active' | 'acknowledged' | 'resolved';
  segment: string | null;
  device_id: string | null;
  sensor_id: string | null;
  message: string;
  data: unknown;
  created_at: string;
  updated_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface RaiseInput {
  type: AlertType;
  severity: Severity;
  message: string;
  segment?: string;
  deviceId?: string;
  sensorId?: string;
  data?: unknown;
}

export interface EventRow {
  id: number;
  time: string;
  kind: string;
  severity: Severity;
  device_id: string | null;
  message: string;
  data: unknown;
}

type Log = { error: (m: string) => void };

export class AlertService {
  /** Open alerts by key, cached to avoid a DB round-trip per telemetry message. */
  private open = new Map<string, Alert>();

  constructor(private readonly log: Log) {}

  async load(): Promise<void> {
    const { rows } = await pool.query<Alert>("SELECT * FROM alerts WHERE state <> 'resolved'");
    for (const a of rows) this.open.set(a.key, a);
  }

  isOpen(key: string): boolean {
    return this.open.has(key);
  }

  openAlerts(): Alert[] {
    return [...this.open.values()];
  }

  async raise(key: string, a: RaiseInput): Promise<Alert | undefined> {
    try {
      const existing = this.open.get(key);
      if (existing) {
        // Refresh: escalate severity / update message, never downgrade.
        if (existing.message === a.message && existing.type === a.type && rank(a.severity) <= rank(existing.severity)) return existing;
        const sev = rank(a.severity) > rank(existing.severity) ? a.severity : existing.severity;
        // `type` may change while an alert is open (e.g. a loss re-classified from leak to theft).
        const { rows } = await pool.query<Alert>(
          `UPDATE alerts SET type=$6, severity=$2, message=$3, segment=COALESCE($4, segment), data=$5, updated_at=now()
             WHERE id=$1 RETURNING *`,
          [existing.id, sev, a.message, a.segment ?? null, json(a.data), a.type],
        );
        return this.publish(rows[0]!);
      }
      const { rows } = await pool.query<Alert>(
        `INSERT INTO alerts (key, type, severity, segment, device_id, sensor_id, message, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [key, a.type, a.severity, a.segment ?? null, a.deviceId ?? null, a.sensorId ?? null, a.message, json(a.data)],
      );
      const alert = this.publish(rows[0]!);
      await this.event('alert', a.severity, `ALERT ${a.type}: ${a.message}`, a.deviceId, { alertId: alert.id, key });
      return alert;
    } catch (e) {
      this.log.error(`raise alert failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async resolve(key: string, note = 'condition cleared'): Promise<void> {
    const existing = this.open.get(key);
    if (!existing) return;
    this.open.delete(key);
    try {
      const { rows } = await pool.query<Alert>(
        "UPDATE alerts SET state='resolved', resolved_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
        [existing.id],
      );
      if (rows[0]) bus.emit('alert', rows[0]);
      await this.event('alert', 'info', `RESOLVED ${existing.type}: ${existing.message} (${note})`, existing.device_id ?? undefined, { alertId: existing.id, key });
    } catch (e) {
      this.log.error(`resolve alert failed: ${(e as Error).message}`);
    }
  }

  async acknowledge(id: number, by: string): Promise<Alert | undefined> {
    const { rows } = await pool.query<Alert>(
      `UPDATE alerts SET state='acknowledged', acknowledged_by=$2, acknowledged_at=now(), updated_at=now()
         WHERE id=$1 AND state='active' RETURNING *`,
      [id, by],
    );
    const a = rows[0];
    if (!a) return undefined;
    this.publish(a);
    await this.event('alert', 'info', `Acknowledged ${a.type} alert #${a.id} by ${by}`, a.device_id ?? undefined, { alertId: a.id });
    return a;
  }

  async event(kind: string, severity: Severity, message: string, deviceId?: string, data?: unknown): Promise<void> {
    try {
      const { rows } = await pool.query<EventRow>(
        'INSERT INTO events (kind, severity, device_id, message, data) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [kind, severity, deviceId ?? null, message, json(data)],
      );
      bus.emit('event', rows[0]!);
    } catch (e) {
      this.log.error(`event insert failed: ${(e as Error).message}`);
    }
  }

  private publish(a: Alert): Alert {
    if (a.state === 'resolved') this.open.delete(a.key);
    else this.open.set(a.key, a);
    bus.emit('alert', a);
    return a;
  }
}

const rank = (s: Severity) => ({ info: 0, warning: 1, critical: 2 })[s];
const json = (d: unknown) => (d === undefined ? null : JSON.stringify(d));
