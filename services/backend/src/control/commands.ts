/**
 * CommandService - the platform -> device direction of the twin.
 *
 *  send()  builds a contract-valid command (id, timestamp, nonce), signs it
 *          when a device key is configured (Phase 6), publishes it with QoS 1
 *          on the device's own topic and records it.
 *  ack     matches the device acknowledgement by cmdId -> executed / rejected,
 *          stores the round-trip latency.
 *  verify  closed loop: the effect must then appear in telemetry (e.g. the
 *          pump state), otherwise the command is flagged "not verified".
 *  timeout no ack after 4 s -> one retry (fresh nonce/timestamp, same cmdId;
 *          commands are idempotent), then "timeout" + alert.
 */
import type { MqttClient } from 'mqtt';
import {
  CHANNEL_QOS, newCmdId, newNonce, topicFor, validateCommand,
  type Ack, type Command, type CommandType, type DeviceId, type Telemetry,
} from '@twin/contracts';
import { bus } from '../bus';
import type { AlertService } from '../alerts/service';
import { pool } from '../db/pool';

export const ACK_TIMEOUT_MS = 4000;
export const MAX_ATTEMPTS = 2;
export const VERIFY_TIMEOUT_MS = 5000;

export type CommandStatus = 'pending' | 'sent' | 'executed' | 'rejected' | 'timeout';

export interface CommandRecord {
  cmdId: string;
  deviceId: DeviceId;
  type: CommandType;
  params: Record<string, unknown>;
  issuedBy: string;
  status: CommandStatus;
  reason?: string;
  attempts: number;
  createdAt: number;
  sentAt?: number;
  ackedAt?: number;
  latencyMs?: number;
  verified: boolean;
}

/** Signs a command for a device (installed by the security module). Returns the wire text. */
export type CommandSigner = (deviceId: DeviceId, msg: Command) => string;

export class CommandService {
  private pending = new Map<string, { rec: CommandRecord; timer: NodeJS.Timeout }>();
  private toVerify = new Map<string, CommandRecord & { deadline: number }>();
  signer: CommandSigner = (_d, msg) => JSON.stringify(msg);

  constructor(
    private readonly mqtt: MqttClient,
    private readonly alerts: AlertService,
    private readonly log: { info: (m: string) => void; error: (m: string) => void },
  ) {
    bus.on('ack', ({ msg }) => void this.onAck(msg));
    bus.on('telemetry', ({ msg }) => this.verify(msg));
  }

  async send(deviceId: DeviceId, type: CommandType, params: Record<string, unknown>, issuedBy: string): Promise<CommandRecord> {
    const rec: CommandRecord = {
      cmdId: newCmdId(), deviceId, type, params, issuedBy, status: 'pending', attempts: 0, createdAt: Date.now(), verified: false,
    };
    // Validate against the contract before anything leaves the platform.
    const probe = { v: 1, cmdId: rec.cmdId, deviceId, ts: Date.now(), nonce: newNonce(), issuedBy, type, params };
    const v = validateCommand(probe);
    if (!v.ok) throw Object.assign(new Error(`invalid command: ${v.errors.join('; ')}`), { status: 400 });

    await pool.query(
      'INSERT INTO commands (cmd_id, device_id, type, params, issued_by, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [rec.cmdId, deviceId, type, JSON.stringify(params), issuedBy, rec.status],
    );
    await this.alerts.event('command', 'info', `${issuedBy} -> ${deviceId}: ${type} ${JSON.stringify(params)}`, deviceId, { cmdId: rec.cmdId });
    this.transmit(rec);
    return rec;
  }

  private transmit(rec: CommandRecord): void {
    rec.attempts++;
    // Fresh timestamp and nonce for every attempt: the device's anti-replay
    // check would (correctly) reject a byte-identical retransmission.
    const msg = { v: 1 as const, cmdId: rec.cmdId, deviceId: rec.deviceId, ts: Date.now(), nonce: newNonce(), issuedBy: rec.issuedBy, type: rec.type, params: rec.params } as Command;
    const wire = this.signer(rec.deviceId, msg);
    this.mqtt.publish(topicFor(rec.deviceId, 'cmd'), wire, CHANNEL_QOS.cmd, (err) => {
      if (err) this.log.error(`command publish failed: ${err.message}`);
    });
    rec.status = 'sent';
    rec.sentAt = Date.now();
    void this.update(rec);
    const timer = setTimeout(() => this.onTimeout(rec.cmdId), ACK_TIMEOUT_MS);
    this.pending.set(rec.cmdId, { rec, timer });
  }

  private onTimeout(cmdId: string): void {
    const p = this.pending.get(cmdId);
    if (!p) return;
    this.pending.delete(cmdId);
    if (p.rec.attempts < MAX_ATTEMPTS) {
      this.log.info(`no ack for ${cmdId}, retrying`);
      this.transmit(p.rec);
      return;
    }
    p.rec.status = 'timeout';
    p.rec.reason = `no acknowledgement after ${MAX_ATTEMPTS} attempts`;
    void this.update(p.rec);
    void this.alerts.raise(`cmd_timeout:${p.rec.deviceId}`, {
      type: 'device_offline', severity: 'critical', deviceId: p.rec.deviceId,
      message: `${p.rec.deviceId} did not acknowledge ${p.rec.type} - device unreachable or command blocked`,
    });
  }

  private async onAck(ack: Ack): Promise<void> {
    const p = this.pending.get(ack.cmdId);
    if (!p) return; // late, duplicate or unknown ack
    if (ack.deviceId !== p.rec.deviceId) return; // ack must come from the addressed device
    clearTimeout(p.timer);
    this.pending.delete(ack.cmdId);
    const rec = p.rec;
    rec.status = ack.status;
    rec.reason = ack.reason;
    rec.ackedAt = Date.now();
    rec.latencyMs = rec.ackedAt - (rec.sentAt ?? rec.createdAt);
    void this.alerts.resolve(`cmd_timeout:${rec.deviceId}`, 'device acknowledged a command');
    if (ack.status === 'executed' && rec.type === 'pump.set') {
      this.toVerify.set(rec.cmdId, { ...rec, deadline: Date.now() + VERIFY_TIMEOUT_MS });
    }
    if (ack.status === 'rejected') {
      void this.alerts.event('command', 'warning', `${rec.deviceId} rejected ${rec.type}: ${ack.reason}`, rec.deviceId, { cmdId: rec.cmdId });
    } else {
      void this.alerts.event('command', 'info', `${rec.deviceId} executed ${rec.type} in ${rec.latencyMs} ms`, rec.deviceId, { cmdId: rec.cmdId });
    }
    await this.update(rec, ack);
  }

  /** Closed loop: does the telemetry now show the commanded pump state? */
  private verify(t: Telemetry): void {
    const now = Date.now();
    for (const [id, rec] of this.toVerify) {
      if (rec.deviceId !== t.deviceId) continue;
      const pump = t.actuators?.pump;
      const want = rec.params as { on: boolean; duty?: number };
      if (pump && pump.on === want.on && (want.duty === undefined || pump.duty === want.duty)) {
        this.toVerify.delete(id);
        rec.verified = true;
        void this.update(rec);
        void this.alerts.resolve(`cmd_unverified:${rec.deviceId}`, 'a later command was verified');
      } else if (now > rec.deadline) {
        this.toVerify.delete(id);
        void this.alerts.raise(`cmd_unverified:${rec.deviceId}`, {
          type: 'device_offline', severity: 'warning', deviceId: rec.deviceId,
          message: `${rec.type} acknowledged by ${rec.deviceId} but its effect is not visible in telemetry`,
        });
      }
    }
  }

  private async update(rec: CommandRecord, ack?: Ack): Promise<void> {
    bus.emit('command', rec);
    try {
      await pool.query(
        `UPDATE commands SET status=$2, reason=$3, attempts=$4, sent_at=$5, acked_at=$6, latency_ms=$7, verified=$8,
           ack=COALESCE($9, ack) WHERE cmd_id=$1`,
        [rec.cmdId, rec.status, rec.reason ?? null, rec.attempts, rec.sentAt ? new Date(rec.sentAt) : null,
          rec.ackedAt ? new Date(rec.ackedAt) : null, rec.latencyMs ?? null, rec.verified, ack ? JSON.stringify(ack) : null],
      );
    } catch (e) {
      this.log.error(`command update failed: ${(e as Error).message}`);
    }
  }
}
