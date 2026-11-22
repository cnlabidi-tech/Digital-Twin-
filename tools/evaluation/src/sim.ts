/**
 * Simulation harness for the offline evaluation: runs the emulator physics
 * (VirtualRig) in virtual time through the REAL twin code (TwinCore) and the
 * REAL plausibility checks, plus two baseline detectors for comparison:
 *
 *   B1 "naive mass balance": F1 - F2 from the reported values > 0.3 L/min for
 *      3 consecutive samples (what a simple SCADA rule would do).
 *   B2 "twin, threshold only": the twin's standardised mass residual > 5 sigma
 *      for 3 s, without CUSUM, without consistency diagnosis.
 *   TWIN: the full digital twin (threshold + CUSUM + diagnosis + plausibility).
 */
import type { Telemetry } from '@twin/contracts';
import { VirtualRig } from '@twin/emulator/virtual';
import { PlausibilityChecker } from '@twin/backend/plausibility';
import { TwinCore, type Intent, type TwinState } from '@twin/backend/twin';

/** Deterministic PRNG (mulberry32) so that every figure in the report is reproducible. */
export function seedRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export type Detector = 'B1' | 'B2' | 'TWIN';

export interface Event {
  ts: number;
  detector: Detector;
  /** shutdown = a confirmed loss while data integrity was NOT in doubt (the supervisor would stop the pump). */
  kind: 'loss' | 'integrity' | 'shutdown';
  /** TWIN only: alert type / segment / position / suspects at the time of the event (updated later). */
  type?: string;
  segment?: string;
  positionM?: number | null;
  suspects?: string[];
}

export class Run {
  readonly rig: VirtualRig;
  readonly core: TwinCore;
  private plaus = new PlausibilityChecker();
  private latest: { F1?: number; F2?: number; pumpOn?: boolean } = {};
  private b1Streak = 0;
  private b2Streak = 0;
  private b1Open = false;
  private b2Open = false;
  private twinLossOpen = false;
  private twinIntegrityOpen = false;
  private plausOpen = false;
  private lastPlausTs = 0;
  events: Event[] = [];
  /** Last TWIN loss alert content (final classification / location). */
  lastLoss: Extract<Intent, { op: 'raise' }>['alert'] | null = null;
  lastIntegrity: Extract<Intent, { op: 'raise' }>['alert'] | null = null;
  state: TwinState | null = null;

  constructor(params: TwinCore['params'], seedStart = 1_800_000_000_000) {
    this.rig = new VirtualRig({ start: seedStart });
    this.core = new TwinCore(params);
  }

  /** Clear events (e.g. after warm-up) but keep detector states. */
  resetEvents(): void {
    this.events = [];
  }

  run(seconds: number): void {
    for (const t of this.rig.run(seconds)) this.feed(t);
  }

  private feed(t: Telemetry): void {
    // --- plausibility (part of TWIN); alarm clears after 15 s without finding (as in the backend)
    const findings = this.plaus.check(t);
    if (findings.length) {
      this.lastPlausTs = t.ts;
      if (!this.plausOpen && !this.twinIntegrityOpen) {
        this.events.push({ ts: t.ts, detector: 'TWIN', kind: 'integrity', suspects: findings.map((f) => f.sensorId) });
      }
      this.plausOpen = true;
    } else if (this.plausOpen && t.ts - this.lastPlausTs > 15_000) {
      this.plausOpen = false;
    }
    // --- B1 naive mass balance on reported values
    if (t.deviceId === 'node-inlet') {
      this.latest.F1 = t.sensors.F1?.v ?? undefined;
      this.latest.pumpOn = t.actuators?.pump.on;
    } else {
      this.latest.F2 = t.sensors.F2?.v ?? undefined;
      if (this.latest.pumpOn && this.latest.F1 !== undefined && this.latest.F2 !== undefined) {
        this.b1Streak = this.latest.F1 - this.latest.F2 > 0.3 ? this.b1Streak + 1 : 0;
        if (this.b1Streak >= 3 && !this.b1Open) {
          this.b1Open = true;
          // a naive system acts on its alarm directly
          this.events.push({ ts: t.ts, detector: 'B1', kind: 'loss' }, { ts: t.ts, detector: 'B1', kind: 'shutdown' });
        }
        if (this.b1Streak === 0 && this.latest.F1 - this.latest.F2 < 0.15) this.b1Open = false;
      }
    }
    // --- TWIN core
    this.core.ingest(t);
    const out = this.core.step();
    if (!out) return;
    this.state = out.state;
    const z = out.state.z;
    if (z && out.state.mode === 'monitoring') {
      this.b2Streak = z.mass > 5 ? this.b2Streak + 1 : 0;
      if (this.b2Streak >= 6 && !this.b2Open) {
        this.b2Open = true;
        this.events.push({ ts: out.state.ts, detector: 'B2', kind: 'loss' }, { ts: out.state.ts, detector: 'B2', kind: 'shutdown' });
      }
      if (z.mass < 2.5) this.b2Open = false;
    }
    for (const i of out.intents) {
      if (i.op === 'raise' && i.key === 'loss') {
        this.lastLoss = i.alert;
        if (!this.twinLossOpen) {
          this.twinLossOpen = true;
          this.events.push({ ts: out.state.ts, detector: 'TWIN', kind: 'loss', type: i.alert.type, segment: i.alert.segment });
        }
      }
      if (i.op === 'raise' && i.key === 'integrity') {
        this.lastIntegrity = i.alert;
        if (!this.twinIntegrityOpen) {
          this.twinIntegrityOpen = true;
          if (!this.plausOpen) this.events.push({ ts: out.state.ts, detector: 'TWIN', kind: 'integrity', suspects: (i.alert.data as { suspects?: string[] }).suspects });
        }
      }
      if (i.op === 'loss_confirmed' && i.unambiguous && !this.twinIntegrityOpen && !this.plausOpen) {
        this.events.push({ ts: out.state.ts, detector: 'TWIN', kind: 'shutdown' });
      }
      if (i.op === 'resolve' && i.key === 'loss') this.twinLossOpen = false;
      if (i.op === 'resolve' && i.key === 'integrity') this.twinIntegrityOpen = false;
    }
  }

  first(detector: Detector, kind: Event['kind'], after = 0): Event | undefined {
    return this.events.find((e) => e.detector === detector && e.kind === kind && e.ts >= after);
  }
}

/** Learn the twin model once (commissioning), as on the real rig. */
export function commission(): TwinCore['params'] {
  const r = new Run(null);
  r.run(80);
  if (!r.core.params) throw new Error('model not learned');
  return r.core.params;
}
