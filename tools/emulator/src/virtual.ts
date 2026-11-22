/**
 * VirtualRig - the emulator WITHOUT network and WITHOUT wall clock.
 * Produces exactly the telemetry the two devices would publish, but in
 * virtual time, so hours of operation are simulated in seconds.
 * Used by the twin's tests and by the Phase 9 evaluation (metrics).
 */
import { DEVICE_HAS_PUMP, DEVICE_SENSORS, type DeviceId, type Telemetry } from '@twin/contracts';
import { applyFdi, createAttack, type Attack, type AttackSpec } from './attacks';
import { countsToReading, pulsesToReading, WindowAverager } from './firmware-logic';
import { coeffFromRate } from './hydraulics';
import { Plant, type FaultType } from './plant';
import { DEFAULT_TOPOLOGY, type SegmentId, type SensorId } from '@twin/contracts';

const TICK_S = 0.05;

export class VirtualRig {
  readonly plant = new Plant();
  /** Virtual clock, ms since epoch. */
  now: number;
  intervalMs: number;
  private attacks: Attack[] = [];
  private seq: Record<DeviceId, number> = { 'node-inlet': 0, 'node-downstream': 0 };
  private avg = new Map<SensorId, WindowAverager>();
  private lastPulses = new Map<SensorId, number>();
  private nextPub: Record<DeviceId, number>;
  private lastPub: Record<DeviceId, number>;
  private ids = 0;

  constructor(opts: { start?: number; intervalMs?: number; downstreamOffsetMs?: number } = {}) {
    this.now = opts.start ?? 1_800_000_000_000;
    this.intervalMs = opts.intervalMs ?? 500;
    this.nextPub = { 'node-inlet': this.now + this.intervalMs, 'node-downstream': this.now + this.intervalMs + (opts.downstreamOffsetMs ?? 130) };
    this.lastPub = { 'node-inlet': this.now, 'node-downstream': this.now };
    for (const s of ['P1', 'P2', 'P3'] as SensorId[]) this.avg.set(s, new WindowAverager());
  }

  /** Advance virtual time; returns the telemetry published meanwhile, in time order. */
  run(seconds: number): Telemetry[] {
    const out: Telemetry[] = [];
    const steps = Math.round(seconds / TICK_S);
    for (let i = 0; i < steps; i++) {
      this.plant.step(TICK_S);
      this.now += TICK_S * 1000;
      for (const s of ['P1', 'P2', 'P3'] as const) this.avg.get(s)!.add(this.plant.readPressureCounts(s));
      for (const dev of ['node-inlet', 'node-downstream'] as DeviceId[]) {
        if (this.now >= this.nextPub[dev]) {
          out.push(this.build(dev));
          this.nextPub[dev] += this.intervalMs;
        }
      }
    }
    return out;
  }

  private build(dev: DeviceId): Telemetry {
    const windowS = (this.now - this.lastPub[dev]) / 1000;
    this.lastPub[dev] = this.now;
    const sensors: Telemetry['sensors'] = {};
    for (const s of DEVICE_SENSORS[dev]) {
      if (s.startsWith('P')) sensors[s] = countsToReading(this.avg.get(s)!.take());
      else {
        const total = this.plant.readPulseCount(s as 'F1' | 'F2');
        sensors[s] = pulsesToReading(total, this.lastPulses.get(s) ?? total, windowS);
        this.lastPulses.set(s, total);
      }
    }
    const t: Telemetry = {
      v: 1, deviceId: dev, bootId: dev === 'node-inlet' ? 'aaaaaaaa' : 'bbbbbbbb', seq: this.seq[dev]++,
      ts: Math.round(this.now), nonce: (this.seq[dev] + 1e15).toString(16).padStart(16, '0').slice(-16),
      intervalMs: this.intervalMs, sensors,
      ...(DEVICE_HAS_PUMP[dev] ? { actuators: { pump: { on: this.plant.pumpOn, duty: this.plant.dutyCmd } } } : {}),
      diag: { uptimeS: 0, rssi: -50, heapFree: 200000, ntpSynced: true },
    };
    applyFdi(t, this.attacks, this.now);
    return t;
  }

  // ------------------------------------------------------------ injections
  leak(segment: SegmentId, rateLpm: number, opts: { fraction?: number; rampS?: number; kind?: 'leak' | 'theft' } = {}): string {
    const pos = DEFAULT_TOPOLOGY.positionsM;
    const seg = DEFAULT_TOPOLOGY.segments[segment];
    const id = `tap-${++this.ids}`;
    this.plant.taps.set(id, {
      id, kind: opts.kind ?? 'leak',
      positionM: pos[seg.from] + (opts.fraction ?? 0.5) * (pos[seg.to] - pos[seg.from]),
      coeff: coeffFromRate(rateLpm), rampS: opts.rampS ?? 0, target: 1, opening: 0,
    });
    return id;
  }
  stopLeak(id: string): void {
    this.plant.taps.delete(id);
  }
  fault(sensor: SensorId, type: FaultType, magnitude?: number): string {
    const id = `fault-${++this.ids}`;
    this.plant.faults.set(id, { id, sensor, type, magnitude, startedAt: this.now });
    return id;
  }
  attack(spec: AttackSpec): string {
    const a = createAttack(`atk-${++this.ids}`, spec, this.now);
    this.attacks.push(a);
    return a.id;
  }
  stopAttack(id: string): void {
    this.attacks = this.attacks.filter((a) => a.id !== id);
  }
}
