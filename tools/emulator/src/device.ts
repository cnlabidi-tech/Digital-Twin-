/**
 * EmulatedDevice - behaves on the network exactly like one ESP32 node:
 *   - one MQTT connection per device, client id = device id,
 *   - retained "online" status + last-will "offline",
 *   - telemetry every `intervalMs` (window-averaged, signed when a key is set),
 *   - command handling with the same security checks the firmware will do
 *     (schema, device id, signature, timestamp window, nonce cache) and an ack.
 */
import mqtt, { type MqttClient } from 'mqtt';
import {
  CHANNEL_QOS, DEVICE_HAS_PUMP, DEVICE_SENSORS, newBootId, newNonce, parseJson, topicFor,
  validateCommand, type Ack, type AckRejectReason, type Command, type DeviceId, type Status, type Telemetry,
} from '@twin/contracts';
import { signMessage, verifyMessage } from '@twin/contracts/signing';
import { applyFdi, applyNetwork, type Attack } from './attacks';
import { countsToReading, pulsesToReading, WindowAverager } from './firmware-logic';
import type { Plant } from './plant';

export const FIRMWARE_VERSION = 'emu-1.0.0';
/** Commands older/newer than this (vs. device clock) are rejected as stale. */
export const CMD_MAX_SKEW_MS = 30_000;

export interface DeviceOptions {
  mqttUrl: string;
  username?: string;
  password?: string;
  ca?: Buffer;
  /** Per-device HMAC key (hex). If absent, messages are sent unsigned. */
  keyHex?: string;
  /** Reject unsigned commands (Phase 6 default when a key is configured). */
  requireSignedCommands?: boolean;
  intervalMs?: number;
  /** Simulated device clock error, ms. */
  clockSkewMs?: number;
  log?: (msg: string) => void;
}

export class EmulatedDevice {
  private client?: MqttClient;
  private bootId = newBootId();
  private seq = 0;
  private bootAt = Date.now();
  private timer?: NodeJS.Timeout;
  private averagers = new Map<string, WindowAverager>();
  private lastPulses = new Map<string, number>();
  /** Pulse counter value at boot: the firmware counter starts from 0 at each boot. */
  private pulseBase = new Map<string, number>();
  private lastPublishAt = Date.now();
  private seenNonces = new Map<string, number>();
  private offlineUntil = 0;
  intervalMs: number;
  connected = false;
  stats = { telemetrySent: 0, commandsExecuted: 0, commandsRejected: 0 };

  constructor(
    readonly id: DeviceId,
    private readonly plant: Plant,
    private readonly attacks: () => Attack[],
    private readonly opts: DeviceOptions,
  ) {
    this.intervalMs = opts.intervalMs ?? 500;
    for (const s of DEVICE_SENSORS[id]) this.averagers.set(s, new WindowAverager());
  }

  private log(m: string) {
    (this.opts.log ?? console.log)(`[${this.id}] ${m}`);
  }

  /** Device clock (may be skewed on purpose). */
  now(): number {
    return Date.now() + (this.opts.clockSkewMs ?? 0);
  }

  private sign(msg: object): string {
    return this.opts.keyHex ? signMessage(msg, this.opts.keyHex) : JSON.stringify(msg);
  }

  // ------------------------------------------------------------------ lifecycle
  start(): void {
    const will: Status = { v: 1, deviceId: this.id, online: false, reason: 'lwt' };
    this.client = mqtt.connect(this.opts.mqttUrl, {
      clientId: this.id,
      username: this.opts.username,
      password: this.opts.password,
      ca: this.opts.ca,
      clean: true,
      keepalive: 10, // broker publishes the last will ~15 s after the device vanishes
      reconnectPeriod: 2000,
      will: { topic: topicFor(this.id, 'status'), payload: Buffer.from(JSON.stringify(will)), qos: 1, retain: true },
    });
    this.client.on('connect', () => {
      this.connected = true;
      this.log(`connected to ${this.opts.mqttUrl}`);
      const st: Status = { v: 1, deviceId: this.id, online: true, ts: this.now(), bootId: this.bootId, fw: FIRMWARE_VERSION, reason: 'boot' };
      this.client!.publish(topicFor(this.id, 'status'), this.sign(st), CHANNEL_QOS.status);
      this.client!.subscribe(topicFor(this.id, 'cmd'), { qos: 1 });
    });
    this.client.on('close', () => (this.connected = false));
    this.client.on('error', (e) => this.log(`mqtt error: ${e.message}`));
    this.client.on('message', (_topic, payload) => this.onCommand(payload));
    this.schedule();
  }

  private schedule(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.publishTelemetry(), this.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    if (!this.client) return;
    const st: Status = { v: 1, deviceId: this.id, online: false, ts: this.now(), reason: 'shutdown' };
    await this.client.publishAsync(topicFor(this.id, 'status'), this.sign(st), CHANNEL_QOS.status).catch(() => undefined);
    await this.client.endAsync();
  }

  /**
   * Simulate a power cut / network loss: the TCP connection is destroyed
   * without a clean MQTT disconnect, so the broker fires the last will.
   */
  goOffline(seconds: number): void {
    this.offlineUntil = Date.now() + seconds * 1000;
    this.client?.stream.destroy();
    this.client?.end(true);
    this.connected = false;
    this.log(`offline for ${seconds}s (ungraceful)`);
    setTimeout(() => {
      this.bootId = newBootId(); // treat as a reboot: seq and pulse counters restart
      this.seq = 0;
      this.lastPulses.clear();
      this.pulseBase.clear();
      this.bootAt = Date.now();
      this.start();
    }, seconds * 1000);
  }

  // ------------------------------------------------------------------ sampling
  /** Called at every physics tick: oversample the ADC like the firmware does. */
  sample(): void {
    for (const s of DEVICE_SENSORS[this.id]) {
      if (s.startsWith('P')) this.averagers.get(s)!.add(this.plant.readPressureCounts(s as 'P1' | 'P2' | 'P3'));
    }
  }

  buildTelemetry(): Telemetry {
    const nowMs = Date.now();
    const windowS = (nowMs - this.lastPublishAt) / 1000;
    this.lastPublishAt = nowMs;
    const sensors: Telemetry['sensors'] = {};
    for (const s of DEVICE_SENSORS[this.id]) {
      if (s.startsWith('P')) {
        sensors[s] = countsToReading(this.averagers.get(s)!.take());
      } else {
        const abs = this.plant.readPulseCount(s as 'F1' | 'F2');
        if (!this.pulseBase.has(s)) this.pulseBase.set(s, abs);
        const total = abs - this.pulseBase.get(s)!;
        sensors[s] = pulsesToReading(total, this.lastPulses.get(s) ?? total, windowS);
        this.lastPulses.set(s, total);
      }
    }
    const t: Telemetry = {
      v: 1,
      deviceId: this.id,
      bootId: this.bootId,
      seq: this.seq++,
      ts: this.now(),
      nonce: newNonce(),
      intervalMs: this.intervalMs,
      sensors,
      ...(DEVICE_HAS_PUMP[this.id] ? { actuators: { pump: { on: this.plant.pumpOn, duty: this.plant.dutyCmd } } } : {}),
      diag: {
        uptimeS: Math.floor((nowMs - this.bootAt) / 1000),
        rssi: -45 - Math.floor(Math.random() * 15),
        heapFree: 180_000 + Math.floor(Math.random() * 20_000),
        ntpSynced: true,
      },
    };
    return t;
  }

  /**
   * A plausible telemetry message built from the current physical truth,
   * WITHOUT touching the device's averaging windows or counters.
   * Used by the spoofing attacker, who imitates the format but has no key.
   */
  buildTelemetryPreview(): Telemetry {
    const truth = this.plant.truth();
    const sensors: Telemetry['sensors'] = {};
    for (const s of DEVICE_SENSORS[this.id]) {
      const v = s.startsWith('P') ? truth.pressure[s as 'P1'] : truth.flow[s as 'F1'];
      sensors[s] = { v: Math.round(v * 1000) / 1000, raw: 0, q: 'ok' };
    }
    return {
      v: 1, deviceId: this.id, bootId: this.bootId, seq: this.seq + 1000, ts: this.now(), nonce: newNonce(),
      intervalMs: this.intervalMs, sensors,
      ...(DEVICE_HAS_PUMP[this.id] ? { actuators: { pump: { on: truth.pumpOn, duty: truth.dutyCmd } } } : {}),
      diag: { uptimeS: 0, rssi: -60, heapFree: 150_000, ntpSynced: true },
    };
  }

  private publishTelemetry(): void {
    if (!this.client || !this.connected || Date.now() < this.offlineUntil) return;
    const t = this.buildTelemetry();
    const attacks = this.attacks();
    applyFdi(t, attacks, Date.now()); // compromised-device attacks (before signing)
    const raw = this.sign(t);
    for (const m of applyNetwork(this.id, raw, attacks, Date.now())) {
      this.client.publish(topicFor(this.id, 'telemetry'), m, CHANNEL_QOS.telemetry);
      this.stats.telemetrySent++;
    }
  }

  // ------------------------------------------------------------------ commands
  private onCommand(payload: Buffer): void {
    const text = payload.toString('utf8');
    const parsed = parseJson(text);
    if (!parsed.ok) return this.log('dropped command: invalid JSON');
    const v = validateCommand(parsed.value);
    const cmdId = (parsed.value as { cmdId?: unknown }).cmdId;
    if (!v.ok) {
      this.log(`rejected command: ${v.errors.join('; ')}`);
      if (typeof cmdId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(cmdId)) this.ack(cmdId, 'rejected', 'invalid_params');
      return;
    }
    const cmd = v.value;
    const reason = this.checkSecurity(cmd, text);
    if (reason) {
      this.stats.commandsRejected++;
      this.log(`rejected ${cmd.type} (${cmd.cmdId}): ${reason}`);
      return this.ack(cmd.cmdId, 'rejected', reason);
    }
    this.execute(cmd);
  }

  /** Same checks as the firmware: signature, device id, freshness, replay. */
  private checkSecurity(cmd: Command, raw: string): AckRejectReason | null {
    if (cmd.deviceId !== this.id) return 'wrong_device';
    if (this.opts.keyHex) {
      const r = verifyMessage(raw, this.opts.keyHex);
      if (!r.ok && (r.reason === 'bad_signature' || this.opts.requireSignedCommands)) return r.reason;
    }
    const now = this.now();
    if (Math.abs(now - cmd.ts) > CMD_MAX_SKEW_MS) return 'stale_timestamp';
    // nonce cache: remember nonces for the freshness window, reject repeats
    for (const [n, exp] of this.seenNonces) if (exp < now) this.seenNonces.delete(n);
    if (this.seenNonces.has(cmd.nonce)) return 'replayed_nonce';
    this.seenNonces.set(cmd.nonce, now + 2 * CMD_MAX_SKEW_MS);
    return null;
  }

  private execute(cmd: Command): void {
    switch (cmd.type) {
      case 'pump.set':
        this.plant.pumpOn = cmd.params.on;
        if (cmd.params.duty !== undefined) this.plant.dutyCmd = cmd.params.duty;
        break;
      case 'telemetry.set_interval':
        this.intervalMs = cmd.params.intervalMs;
        this.schedule();
        break;
      case 'ping':
        break;
    }
    this.stats.commandsExecuted++;
    this.log(`executed ${cmd.type} from ${cmd.issuedBy} (${cmd.cmdId})`);
    this.ack(cmd.cmdId, 'executed');
  }

  private ack(cmdId: string, status: Ack['status'], reason?: AckRejectReason): void {
    const ack: Ack = {
      v: 1,
      cmdId,
      deviceId: this.id,
      ts: this.now(),
      nonce: newNonce(),
      status,
      ...(reason ? { reason } : {}),
      state: {
        ...(DEVICE_HAS_PUMP[this.id] ? { pump: { on: this.plant.pumpOn, duty: this.plant.dutyCmd } } : {}),
        intervalMs: this.intervalMs,
      },
    };
    this.client?.publish(topicFor(this.id, 'ack'), this.sign(ack), CHANNEL_QOS.ack);
  }
}
