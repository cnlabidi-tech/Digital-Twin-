/**
 * Emulator orchestrator: one shared physical plant, two emulated devices,
 * plus the injection API (leaks, theft, valve, faults, attacks, outages).
 *
 * Every injection is written to a GROUND-TRUTH log (JSON lines). The twin
 * never sees this file; Phase 9 compares it with the twin's alerts to compute
 * detection rate, false alarms and detection delay.
 */
import { appendFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import {
  DEFAULT_TOPOLOGY, DEVICE_IDS, newNonce, randomHex, SENSORS, topicFor,
  type DeviceId, type SegmentId, type SensorId,
} from '@twin/contracts';
import { signMessage } from '@twin/contracts/signing';
import { createAttack, type Attack, type AttackSpec } from './attacks';
import { EmulatedDevice, type DeviceOptions } from './device';
import { coeffFromRate } from './hydraulics';
import { Plant, type FaultType, type TapSpec } from './plant';

export const TICK_MS = 50;

export interface EmulatorOptions {
  mqttUrl: string;
  intervalMs?: number;
  /** Per-device connection settings (credentials, keys) - Phase 6. */
  device?: Partial<Record<DeviceId, Partial<DeviceOptions>>>;
  ca?: Buffer;
  truthLog?: string;
  quiet?: boolean;
}

export interface TapRequest {
  kind: 'leak' | 'theft';
  segment?: SegmentId;
  /** Position inside the segment, 0..1 (default 0.5). Ignored if positionM is given. */
  fraction?: number;
  positionM?: number;
  /** Flow lost at 3 bar, L/min (default leak 0.4, theft 0.8). */
  rateLpm?: number;
  /** Seconds to fully open (default leak 0 = burst, theft 8 = valve turned by hand). */
  rampS?: number;
  id?: string;
}

export class Emulator {
  readonly plant = new Plant();
  readonly devices: Record<DeviceId, EmulatedDevice>;
  private attacks = new Map<string, Attack>();
  private ticker?: NodeJS.Timeout;
  private spoofer?: MqttClient;
  private spoofTimer?: NodeJS.Timeout;
  private counter = 0;
  readonly startedAt = Date.now();

  constructor(private readonly opts: EmulatorOptions) {
    const log = opts.quiet ? () => undefined : (m: string) => console.log(m);
    this.devices = Object.fromEntries(
      DEVICE_IDS.map((id) => [
        id,
        new EmulatedDevice(id, this.plant, () => [...this.attacks.values()], {
          mqttUrl: opts.mqttUrl,
          intervalMs: opts.intervalMs,
          ca: opts.ca,
          log,
          ...opts.device?.[id],
        }),
      ]),
    ) as Record<DeviceId, EmulatedDevice>;
  }

  private nextId(prefix: string) {
    return `${prefix}-${++this.counter}`;
  }

  /** Append an event to the ground-truth log. */
  truth(event: string, data: object = {}): void {
    if (!this.opts.truthLog) return;
    appendFileSync(this.opts.truthLog, JSON.stringify({ ts: Date.now(), event, ...data }) + '\n');
  }

  start(): void {
    this.truth('emulator_start');
    for (const d of Object.values(this.devices)) d.start();
    this.ticker = setInterval(() => {
      this.plant.step(TICK_MS / 1000);
      for (const d of Object.values(this.devices)) d.sample();
    }, TICK_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.ticker);
    this.stopSpoofer();
    await Promise.all(Object.values(this.devices).map((d) => d.stop()));
    this.truth('emulator_stop');
  }

  // ------------------------------------------------------------ hydraulics
  addTap(req: TapRequest): TapSpec {
    if (req.kind !== 'leak' && req.kind !== 'theft') throw new Error('kind must be leak or theft');
    const seg = DEFAULT_TOPOLOGY.segments[req.segment ?? 'B'];
    if (!seg) throw new Error('segment must be A or B');
    const pos = DEFAULT_TOPOLOGY.positionsM;
    const positionM = req.positionM ?? pos[seg.from] + (req.fraction ?? 0.5) * (pos[seg.to] - pos[seg.from]);
    const rate = req.rateLpm ?? (req.kind === 'leak' ? 0.4 : 0.8);
    if (!(rate > 0 && rate < 5)) throw new Error('rateLpm must be in (0, 5)');
    const tap: TapSpec = {
      id: req.id ?? this.nextId(req.kind),
      kind: req.kind,
      positionM,
      coeff: coeffFromRate(rate),
      rampS: req.rampS ?? (req.kind === 'leak' ? 0 : 8),
      target: 1,
      opening: 0,
    };
    this.plant.taps.set(tap.id, tap);
    this.truth(`${req.kind}_start`, { id: tap.id, segment: segmentOf(positionM), positionM, rateLpm: rate, rampS: tap.rampS });
    return tap;
  }

  removeTap(id: string): boolean {
    const tap = this.plant.taps.get(id);
    if (!tap) return false;
    this.plant.taps.delete(id);
    this.truth(`${tap.kind}_stop`, { id });
    return true;
  }

  setValve(opening: number): void {
    if (!(opening >= 0.05 && opening <= 1)) throw new Error('outletOpening must be in [0.05, 1]');
    this.plant.outletOpening = opening;
    this.truth('valve_change', { outletOpening: opening });
  }

  // ---------------------------------------------------------------- faults
  addFault(sensor: SensorId, type: FaultType, magnitude?: number): string {
    if (!SENSORS[sensor]) throw new Error(`unknown sensor ${sensor}`);
    if (!['stuck', 'drift', 'disconnected', 'noisy'].includes(type)) throw new Error(`unknown fault ${type}`);
    if (SENSORS[sensor].kind === 'flow' && (type === 'drift' || type === 'noisy')) {
      throw new Error('flow sensors support only stuck / disconnected faults');
    }
    const id = this.nextId('fault');
    this.plant.faults.set(id, { id, sensor, type, magnitude, startedAt: Date.now() });
    this.truth('fault_start', { id, sensor, type, magnitude });
    return id;
  }

  removeFault(id: string): boolean {
    const ok = this.plant.faults.delete(id);
    if (ok) this.truth('fault_stop', { id });
    return ok;
  }

  // --------------------------------------------------------------- attacks
  addAttack(spec: AttackSpec): Attack {
    const a = createAttack(this.nextId('attack'), spec, Date.now());
    this.attacks.set(a.id, a);
    if (a.type === 'spoof') this.startSpoofer(a);
    this.truth('attack_start', { id: a.id, type: a.type, device: a.device, sensor: a.sensor });
    return a;
  }

  removeAttack(id: string): boolean {
    const a = this.attacks.get(id);
    if (!a) return false;
    this.attacks.delete(id);
    if (a.type === 'spoof') this.stopSpoofer();
    this.truth('attack_stop', { id, type: a.type });
    return true;
  }

  /**
   * Spoofing: an OUTSIDER (own MQTT connection, no device key) publishes fake
   * telemetry on the victim's topic, signed with a random key. With Phase 6
   * ACLs the broker refuses it; without them the backend's signature check must.
   */
  private startSpoofer(a: Attack): void {
    this.stopSpoofer();
    this.spoofer = mqtt.connect(this.opts.mqttUrl, { clientId: `intruder-${randomHex(3)}`, ca: this.opts.ca, reconnectPeriod: 0 });
    this.spoofer.on('error', () => undefined);
    const victim = this.devices[a.device];
    this.spoofTimer = setInterval(() => {
      const t = victim.buildTelemetryPreview();
      for (const r of Object.values(t.sensors)) if (r.v !== null) r.v = Math.round(r.v * 0.5 * 1000) / 1000; // fake "half" values
      t.nonce = newNonce();
      this.spoofer?.publish(topicFor(a.device, 'telemetry'), signMessage(t, randomHex(32)));
    }, victim.intervalMs);
  }

  private stopSpoofer(): void {
    clearInterval(this.spoofTimer);
    this.spoofer?.end(true);
    this.spoofer = undefined;
  }

  // ---------------------------------------------------------------- outages
  deviceOffline(id: DeviceId, seconds: number): void {
    const d = this.devices[id];
    if (!d) throw new Error(`unknown device ${id}`);
    d.goOffline(seconds);
    this.truth('device_offline', { device: id, seconds });
  }

  // ----------------------------------------------------------------- misc
  /** Local pump switch (like pressing a button on the rig) - for tests only. */
  setPump(on: boolean, duty?: number): void {
    this.plant.pumpOn = on;
    if (duty !== undefined) this.plant.dutyCmd = duty;
    this.truth('pump_local', { on, duty });
  }

  reset(): void {
    this.plant.clearInjections();
    for (const id of [...this.attacks.keys()]) this.removeAttack(id);
    this.truth('reset');
  }

  state() {
    return {
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      truth: this.plant.truth(),
      taps: [...this.plant.taps.values()],
      faults: [...this.plant.faults.values()],
      attacks: [...this.attacks.values()].map(({ recorded, recordedRaw, fakePulses, frozen, ...rest }) => rest),
      devices: Object.fromEntries(
        Object.values(this.devices).map((d) => [d.id, { connected: d.connected, intervalMs: d.intervalMs, ...d.stats }]),
      ),
    };
  }
}

export function segmentOf(positionM: number): SegmentId | 'other' {
  const p = DEFAULT_TOPOLOGY.positionsM;
  if (positionM >= p.P1 && positionM < p.P2) return 'A';
  if (positionM >= p.P2 && positionM <= p.P3) return 'B';
  return 'other';
}
