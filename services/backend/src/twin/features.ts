/**
 * Feature extraction: turns the two asynchronous telemetry streams into one
 * synchronised, de-noised measurement vector per twin step.
 *
 * - Pressures: mean of the sensor values inside the window.
 * - Flows:     from the CUMULATIVE PULSE COUNTER (raw), not from the reported
 *              instantaneous flow:  Q = d(pulses) / (K * dt).
 *              Over a 4 s window the +/-1 pulse quantisation error drops from
 *              0.27 L/min (0.5 s sample) to 0.03 L/min.
 * Windows are aligned on DEVICE timestamps, so network jitter does not matter.
 */
import type { DeviceId, SensorId, Telemetry } from '@twin/contracts';

/** Nominal YF-S201 K-factor used by the firmware (pulses/s per L/min). */
export const FLOW_K = 7.5;

export interface Sample {
  ts: number;
  bootId: string;
  values: Partial<Record<SensorId, number | null>>;
  raw: Partial<Record<SensorId, number>>;
  quality: Partial<Record<SensorId, string>>;
  pump?: { on: boolean; duty: number };
}

export interface Features {
  /** Window end (device time, ms). */
  ts: number;
  windowS: number;
  P1: number;
  P2: number;
  P3: number;
  /** Flows computed from pulses (L/min). */
  F1: number;
  F2: number;
  /** Short-window (1 s) loss, for onset-shape analysis. */
  lossFast: number;
  pumpOn: boolean;
  duty: number;
  /** All sensors have quality ok in the window. */
  qualityOk: boolean;
  badSensors: SensorId[];
}

export class SampleBuffer {
  private buf: Record<DeviceId, Sample[]> = { 'node-inlet': [], 'node-downstream': [] };

  constructor(private readonly keepMs = 60_000) {}

  add(t: Telemetry): void {
    const list = this.buf[t.deviceId];
    const s: Sample = {
      ts: t.ts,
      bootId: t.bootId,
      values: Object.fromEntries(Object.entries(t.sensors).map(([k, r]) => [k, r.v])),
      raw: Object.fromEntries(Object.entries(t.sensors).map(([k, r]) => [k, r.raw])),
      quality: Object.fromEntries(Object.entries(t.sensors).map(([k, r]) => [k, r.q])),
      pump: t.actuators?.pump,
    };
    // Out-of-order or duplicate timestamps are ignored (replay protection is elsewhere).
    const last = list[list.length - 1];
    if (last && s.ts <= last.ts) return;
    // A reboot restarts the pulse counter: drop older samples of this device.
    if (last && last.bootId !== s.bootId) list.length = 0;
    list.push(s);
    while (list.length && list[0]!.ts < s.ts - this.keepMs) list.shift();
  }

  latestTs(dev: DeviceId): number | undefined {
    const l = this.buf[dev];
    return l[l.length - 1]?.ts;
  }

  window(dev: DeviceId, from: number, to: number): Sample[] {
    return this.buf[dev].filter((s) => s.ts > from && s.ts <= to);
  }

  /** Last sample at or before `ts`. */
  at(dev: DeviceId, ts: number): Sample | undefined {
    const l = this.buf[dev];
    for (let i = l.length - 1; i >= 0; i--) if (l[i]!.ts <= ts) return l[i];
    return undefined;
  }

  clear(): void {
    this.buf = { 'node-inlet': [], 'node-downstream': [] };
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Flow from the pulse counter between the sample at/before `from` and the last sample before `to`. */
function pulseFlow(buf: SampleBuffer, dev: DeviceId, id: SensorId, from: number, to: number): number {
  const a = buf.at(dev, from);
  const b = buf.at(dev, to);
  if (!a || !b || b.ts <= a.ts || a.bootId !== b.bootId) return NaN;
  const dp = (b.raw[id] ?? 0) - (a.raw[id] ?? 0);
  if (dp < 0) return NaN; // counter reset / tampering
  return dp / FLOW_K / ((b.ts - a.ts) / 1000);
}

/**
 * Compute the feature vector for the window ending at `end` (device ms).
 * Returns null when one device has no data in the window (stale / offline).
 */
export function extract(buf: SampleBuffer, end: number, windowS = 4): Features | null {
  const start = end - windowS * 1000;
  const inl = buf.window('node-inlet', start, end);
  const dwn = buf.window('node-downstream', start, end);
  if (inl.length < 2 || dwn.length < 2) return null;

  const vals = (ss: Sample[], id: SensorId) =>
    ss.map((s) => s.values[id]).filter((v): v is number => typeof v === 'number');
  const bad = new Set<SensorId>();
  for (const s of [...inl, ...dwn]) for (const [k, q] of Object.entries(s.quality)) if (q !== 'ok') bad.add(k as SensorId);

  const F1 = pulseFlow(buf, 'node-inlet', 'F1', start, end);
  const F2 = pulseFlow(buf, 'node-downstream', 'F2', start, end);
  const lossFast = pulseFlow(buf, 'node-inlet', 'F1', end - 2000, end) - pulseFlow(buf, 'node-downstream', 'F2', end - 2000, end);
  const pump = inl[inl.length - 1]!.pump;

  return {
    ts: end,
    windowS,
    P1: mean(vals(inl, 'P1')),
    P2: mean(vals(dwn, 'P2')),
    P3: mean(vals(dwn, 'P3')),
    F1,
    F2,
    lossFast,
    pumpOn: pump?.on ?? false,
    duty: pump?.duty ?? 0,
    qualityOk: bad.size === 0,
    badSensors: [...bad],
  };
}
