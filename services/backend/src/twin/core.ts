/**
 * TwinCore - the digital twin's reasoning, independent of MQTT, database and
 * wall clock (time comes from the device timestamps). This makes it fully
 * testable offline by feeding it simulated telemetry at high speed.
 *
 * Every step (each 0.5 s of device time) it:
 *   1. builds a synchronised feature vector (features.ts),
 *   2. LEARNS the model during commissioning, or
 *   3. computes expected values and residuals (model.ts),
 *   4. detects persistent loss with a threshold + CUSUM (cusum.ts),
 *   5. checks physical consistency and isolates suspect sensors (diagnosis.ts),
 *   6. locates the loss and classifies leak vs theft (model.ts, classifier.ts),
 *   7. returns its state + "intents" (open/resolve alerts) for the engine.
 */
import { DEFAULT_TOPOLOGY, type SegmentId, type SensorId, type Telemetry } from '@twin/contracts';
import type { RaiseInput } from '../alerts/service';
import { classify, riseTime, type OnsetPoint, type PastLoss } from './classifier';
import { Cusum } from './cusum';
import { diagnose, Z_VIOLATION, type Diagnosis } from './diagnosis';
import { extract, SampleBuffer, type Features } from './features';
import { expected, fitModel, locate, RESIDUALS, residuals, type ModelParams, type ResidualName } from './model';

export const STEP_MS = 500;
export const LEARN_STEPS = 120; // 60 s of healthy steady operation
export const PERSIST_STEPS = 6; // 3 s above threshold before declaring
export const CLEAR_STEPS = 20; // 10 s back to normal before resolving
export const TRANSIENT_HOLD_MS = 8000;

export type TwinMode = 'waiting' | 'learning' | 'monitoring' | 'transient' | 'idle' | 'stale';
export type SegmentState = 'normal' | 'warning' | 'leak' | 'theft' | 'unknown';

export type Intent =
  | { op: 'raise'; key: string; alert: RaiseInput }
  | { op: 'resolve'; key: string; note: string }
  | { op: 'event'; severity: 'info' | 'warning' | 'critical'; message: string; data?: unknown }
  | { op: 'learned'; params: ModelParams }
  | { op: 'loss_confirmed'; kind: 'leak' | 'theft'; segment?: SegmentId; lossLpm: number };

export interface TwinState {
  ts: number;
  mode: TwinMode;
  learning: { progress: number; needed: number } | null;
  measured: Features | null;
  expected: ReturnType<typeof expected> | null;
  residuals: Record<ResidualName, number> | null;
  z: Record<ResidualName, number> | null;
  cusum: { pos: number; neg: number; h: number };
  loss: { lpm: number; detected: boolean; kind?: 'leak' | 'theft'; classified: boolean; since?: number } | null;
  location: { segment: SegmentId; positionM: number; fA: number; fB: number } | null;
  diagnosis: Diagnosis | null;
  segments: Record<SegmentId, { state: SegmentState }>;
  model: Pick<ModelParams, 'pumpA' | 'pumpB' | 'RA' | 'RB' | 'Rout' | 'c' | 'learnedAt' | 'samples'> & { RoutTracked: number } | null;
  /** Values appended to the dashboard's twin charts. */
  series: Record<string, number | null>;
}

interface ActiveLoss {
  since: number;
  kind: 'leak' | 'theft';
  classified: boolean;
  reason: string;
  positionM: number | null;
  segment: SegmentId | null;
  lossLpm: number;
  lastMessageAt: number;
  baseline: number;
}

const finite = (f: Features) => [f.P1, f.P2, f.P3, f.F1, f.F2].every(Number.isFinite);
const r2 = (x: number) => Math.round(x * 100) / 100;

export class TwinCore {
  readonly buf = new SampleBuffer();
  params: ModelParams | null;
  private RoutTracked = 0;
  private learnSet: Features[] = [];
  private learningRequested: boolean;
  private cusum = new Cusum(1.0, 15);
  private lastStep = 0;
  private history: Features[] = []; // last 60 s of features
  private onset: OnsetPoint[] = []; // last 60 s of 2-s loss
  private lossStreak = 0;
  private gainStreak = 0;
  private clearStreak = 0;
  private inconsistentStreak = 0;
  private consistentStreak = 0;
  private active: ActiveLoss | null = null;
  private integrityOpen = false;
  private pastLosses: PastLoss[] = [];
  private transientUntil = 0;
  private lastPump: { on: boolean; duty: number } | null = null;
  private locEwma: { fA: number; fB: number } | null = null;
  /** Device time when the mass residual last rose above 3 sigma. */
  private lossOnsetTs: number | null = null;
  readonly LA: number;
  readonly LB: number;

  constructor(params: ModelParams | null = null) {
    this.params = params;
    this.RoutTracked = params?.Rout ?? 0;
    this.learningRequested = !params;
    const p = DEFAULT_TOPOLOGY.positionsM;
    this.LA = p.P2 - p.P1;
    this.LB = p.P3 - p.P2;
  }

  /** Forget the model and learn a new baseline (after maintenance / calibration). */
  relearn(): void {
    this.params = null;
    this.learnSet = [];
    this.learningRequested = true;
    this.cusum.reset();
  }

  /**
   * After a restart, re-attach alerts that are still open in the database so
   * that they can be resolved when the condition clears.
   */
  restoreOpen(open: { loss?: { kind: 'leak' | 'theft'; segment: SegmentId | null; positionM: number | null; lossLpm: number }; integrity?: boolean }): void {
    if (open.loss) {
      this.active = {
        since: 0, kind: open.loss.kind, classified: true, reason: 'restored after restart',
        positionM: open.loss.positionM, segment: open.loss.segment, lossLpm: open.loss.lossLpm, lastMessageAt: 0, baseline: 0,
      };
    }
    if (open.integrity) this.integrityOpen = true;
  }

  ingest(t: Telemetry): void {
    this.buf.add(t);
  }

  /** Run one twin step if enough new device time has elapsed. */
  step(): { state: TwinState; intents: Intent[] } | null {
    const ti = this.buf.latestTs('node-inlet');
    const td = this.buf.latestTs('node-downstream');
    if (ti === undefined || td === undefined) return null;
    const end = Math.min(ti, td);
    if (end - this.lastStep < STEP_MS - 50) return null;
    this.lastStep = end;
    const intents: Intent[] = [];

    // Devices out of sync / one silent => no reasoning on stale data.
    if (Math.abs(ti - td) > 3000) return { state: this.blank(end, 'stale'), intents };
    const f = extract(this.buf, end);
    if (!f || !finite(f)) return { state: this.blank(end, 'stale', f), intents };

    this.history.push(f);
    while (this.history.length && this.history[0]!.ts < end - 60_000) this.history.shift();

    // Pump command changes are known transients.
    if (this.lastPump && (this.lastPump.on !== f.pumpOn || this.lastPump.duty !== f.duty)) {
      this.transientUntil = end + TRANSIENT_HOLD_MS + f.windowS * 1000;
    }
    this.lastPump = { on: f.pumpOn, duty: f.duty };

    if (!f.pumpOn || f.F1 < 0.3) {
      this.lossStreak = this.gainStreak = 0;
      return { state: this.blank(end, 'idle', f), intents };
    }

    // ---------------------------------------------------------------- learning
    if (!this.params) {
      if (!this.learningRequested) return { state: this.blank(end, 'waiting', f), intents };
      const transient = end < this.transientUntil || this.commonModeChange(f);
      if (f.qualityOk && !transient) this.learnSet.push(f);
      if (this.learnSet.length >= LEARN_STEPS) {
        this.params = fitModel(this.learnSet);
        this.RoutTracked = this.params.Rout;
        this.learnSet = [];
        this.learningRequested = false;
        this.cusum.reset();
        intents.push({ op: 'learned', params: this.params });
        intents.push({ op: 'event', severity: 'info', message: `Twin model learned from ${LEARN_STEPS} healthy samples (RA=${this.params.RA.toFixed(4)}, RB=${this.params.RB.toFixed(4)}, c=${this.params.c.toFixed(3)})` });
        intents.push({ op: 'resolve', key: 'model', note: 'model learned' });
      } else if (this.learnSet.length === 1) {
        intents.push({ op: 'raise', key: 'model', alert: { type: 'model', severity: 'info', message: 'Learning baseline: keep the pipe healthy and steady for 60 s' } });
      }
      const st = this.blank(end, 'learning', f);
      st.learning = { progress: this.learnSet.length, needed: LEARN_STEPS };
      return { state: st, intents };
    }

    // -------------------------------------------------------------- monitoring
    const p = this.params;
    const r = residuals(f, p, this.RoutTracked);
    const z = Object.fromEntries(RESIDUALS.map((k) => [k, (r[k] - p.mu[k]) / p.sigma[k]])) as Record<ResidualName, number>;
    const transient = end < this.transientUntil || this.commonModeChange(f);
    if (transient && end >= this.transientUntil) this.transientUntil = end + TRANSIENT_HOLD_MS;

    const lossLpm = r.mass - p.mu.mass;
    this.onset.push({ ts: end, loss: f.lossFast - p.mu.mass });
    while (this.onset.length && this.onset[0]!.ts < end - 60_000) this.onset.shift();

    // Outlet resistance follows the (manual) outlet valve: track it while the
    // inlet side and the mass balance agree that nothing abnormal happens.
    if (Math.abs(z.mass) < 3 && Math.abs(z.pump) < 3 && f.qualityOk) {
      const inst = f.P3 / (p.c * f.F2) ** 2;
      this.RoutTracked += (transient ? 0.3 : 0.2) * (inst - this.RoutTracked);
    }

    let cus = { pos: this.cusum.pos, neg: this.cusum.neg, alarmPos: this.cusum.pos > this.cusum.h, alarmNeg: this.cusum.neg > this.cusum.h };
    if (!transient) {
      cus = this.cusum.update(z.mass);
      this.lossStreak = z.mass > Z_VIOLATION ? this.lossStreak + 1 : 0;
      this.gainStreak = z.mass < -Z_VIOLATION ? this.gainStreak + 1 : 0;
    }
    const lossDetected = !!this.active || this.lossStreak >= PERSIST_STEPS || cus.alarmPos;
    const gainDetected = this.gainStreak >= PERSIST_STEPS || cus.alarmNeg;

    const rawLoc = locate(f, p, this.LA, this.LB);
    if (rawLoc) {
      this.locEwma = this.locEwma
        ? { fA: this.locEwma.fA + 0.3 * (rawLoc.fA - this.locEwma.fA), fB: this.locEwma.fB + 0.3 * (rawLoc.fB - this.locEwma.fB) }
        : { fA: rawLoc.fA, fB: rawLoc.fB };
    } else {
      this.locEwma = null;
    }
    const loc = rawLoc && this.locEwma ? locate2(this.locEwma, this.LA, this.LB) : null;

    // Right after a loss starts, the 4-s windows of pressures and pulse-flows
    // fill at different rates: the pressure profile is meaningless for one
    // window length, so the localisation consistency check waits.
    if (z.mass > 3) this.lossOnsetTs ??= end;
    else if (!this.active) this.lossOnsetTs = null;
    const locSettled = this.lossOnsetTs !== null && end - this.lossOnsetTs > f.windowS * 1000 + 1000;
    const diag = transient
      ? { hypothesis: 'healthy' as const, violated: [], suspects: [], reasons: ['transient: detection paused'] }
      : diagnose(z, lossDetected, gainDetected, locSettled ? loc : null);

    // ------------------------------------------------- data integrity (FDI / sensor)
    if (!transient) {
      if (diag.hypothesis === 'inconsistent') {
        this.inconsistentStreak++;
        this.consistentStreak = 0;
      } else {
        this.consistentStreak++;
        this.inconsistentStreak = 0;
      }
      if (this.inconsistentStreak >= PERSIST_STEPS) {
        this.integrityOpen = true;
        intents.push({
          op: 'raise',
          key: 'integrity',
          alert: {
            type: 'fdi',
            severity: 'critical',
            message:
              `Measurements violate the physics${diag.suspects.length ? ` - suspect ${diag.suspects.join(', ')}` : ''}: possible false data injection or sensor fault` +
              (z.mass > Z_VIOLATION ? `. A flow imbalance of ${r2(lossLpm)} L/min is also seen but cannot be trusted - inspect the pipe` : ''),
            sensorId: diag.suspects.length === 1 ? diag.suspects[0] : undefined,
            data: { suspects: diag.suspects, reasons: diag.reasons, violated: diag.violated },
          },
        });
      } else if (this.integrityOpen && this.consistentStreak >= CLEAR_STEPS) {
        this.integrityOpen = false;
        intents.push({ op: 'resolve', key: 'integrity', note: 'measurements consistent again' });
      }
    }

    // ---------------------------------------------------------------- loss
    if (!transient && diag.hypothesis === 'loss' && !this.integrityOpen) {
      if (!this.active) {
        this.cusum.reset(); // start a fresh accumulation once the alarm is raised
        this.active = {
          since: end, kind: 'leak', classified: false, reason: 'classification pending',
          positionM: null, segment: null, lossLpm, lastMessageAt: 0,
          baseline: median(this.onset.filter((o) => o.ts < end - 15_000).map((o) => o.loss)) ?? 0,
        };
      }
      const a = this.active;
      const visible = z.mass > 3;
      if (visible) a.lossLpm += 0.3 * (lossLpm - a.lossLpm);
      // Localise only once the 4-s window contains post-onset data only.
      if (visible && loc && end - a.since >= f.windowS * 1000) {
        a.positionM = loc.positionM;
        a.segment = loc.segment;
      }
      // Classify once the loss level is stable (or after 25 s at the latest).
      // "Stable" = the 4-s loss changed less than 10 % over the last 3 s.
      if (visible && !a.classified && end - a.since > 4000) {
        const before = this.history.find((h) => h.ts >= end - 3000);
        const lossBefore = before ? before.F1 - p.c * before.F2 - p.mu.mass : lossLpm;
        const stable = Math.abs(lossLpm - lossBefore) < Math.max(0.08, 0.1 * Math.abs(lossLpm));
        if (stable || end - a.since > 25_000) {
          const lossHist = this.history.map((h) => ({ ts: h.ts, loss: h.F1 - p.c * h.F2 - p.mu.mass }));
          const rise = riseTime(lossHist.filter((o) => o.ts >= a.since - 20_000), 0, lossLpm);
          const c = classify(rise, a.positionM, this.pastLosses, end);
          a.kind = c.kind;
          a.reason = c.reason;
          a.classified = true;
          intents.push({ op: 'loss_confirmed', kind: c.kind, segment: a.segment ?? undefined, lossLpm: a.lossLpm });
          a.lastMessageAt = 0; // force alert update
        }
      }
      if (visible && end - a.lastMessageAt > 5000) {
        a.lastMessageAt = end;
        const where = a.segment
          ? `segment ${a.segment}, ~${a.positionM!.toFixed(2)} m from P1`
          : end - a.since < f.windowS * 1000 ? 'locating...' : 'location undetermined (loss too small)';
        const pct = (100 * a.lossLpm) / Math.max(f.F1, 0.1);
        intents.push({
          op: 'raise',
          key: 'loss',
          alert: {
            type: a.kind,
            severity: 'critical',
            segment: a.segment ?? undefined,
            message: `${a.kind === 'theft' ? 'Theft suspected' : 'Leak detected'}: ${r2(a.lossLpm)} L/min lost (${pct.toFixed(0)} %), ${where}. ${a.classified ? a.reason : 'Classifying leak vs theft...'}`,
            data: { lossLpm: r2(a.lossLpm), positionM: a.positionM, classified: a.classified, reason: a.reason },
          },
        });
      }
    }
    if (this.active && !transient) {
      if (z.mass < 2.5) this.clearStreak++;
      else this.clearStreak = 0;
      if (this.clearStreak >= CLEAR_STEPS) {
        this.pastLosses.push({ resolvedAt: end, positionM: this.active.positionM });
        this.pastLosses = this.pastLosses.filter((x) => end - x.resolvedAt < 30 * 60_000);
        this.active = null;
        this.clearStreak = 0;
        this.lossStreak = 0;
        this.cusum.reset();
        intents.push({ op: 'resolve', key: 'loss', note: 'mass balance restored' });
      }
    }

    // ---------------------------------------------------------------- state
    const segState = (s: SegmentId): SegmentState => {
      if (this.integrityOpen) return 'unknown';
      if (this.active && (this.active.segment === s || this.active.segment === null)) return this.active.kind;
      if (z.mass > 3 && (!loc || loc.segment === s)) return 'warning';
      return 'normal';
    };
    const exp = expected(f, p, this.RoutTracked);
    const state: TwinState = {
      ts: end,
      mode: transient ? 'transient' : 'monitoring',
      learning: null,
      measured: f,
      expected: exp,
      residuals: r,
      z,
      cusum: { pos: this.cusum.pos, neg: this.cusum.neg, h: this.cusum.h },
      loss: {
        lpm: lossLpm,
        detected: !!this.active,
        kind: this.active?.kind,
        classified: this.active?.classified ?? false,
        since: this.active?.since,
      },
      location: loc ? { segment: loc.segment, positionM: loc.positionM, fA: loc.fA, fB: loc.fB } : null,
      diagnosis: diag,
      segments: { A: { state: segState('A') }, B: { state: segState('B') } },
      model: { pumpA: p.pumpA, pumpB: p.pumpB, RA: p.RA, RB: p.RB, Rout: p.Rout, c: p.c, learnedAt: p.learnedAt, samples: p.samples, RoutTracked: this.RoutTracked },
      series: {
        loss: lossLpm,
        zMass: z.mass,
        cusumPos: this.cusum.pos,
        cusumNeg: this.cusum.neg,
        zPump: z.pump,
        zOutlet: z.outlet,
        F2exp: exp.F2,
        P2exp: exp.P2,
        P3exp: exp.P3,
      },
    };
    return { state, intents };
  }

  /**
   * Common-mode flow change = both flows move together (operating change:
   * valve, pump speed). A leak moves them in OPPOSITE directions (F1 up, F2
   * down), so it is never mistaken for a transient.
   */
  private commonModeChange(f: Features): boolean {
    const old = this.history.find((h) => h.ts >= f.ts - 2000);
    if (!old || old === f) return false;
    const d1 = f.F1 - old.F1;
    const d2 = f.F2 - old.F2;
    // both flows must move, in the same direction (a single forged flow is NOT a transient)
    return Math.sign(d1) === Math.sign(d2) && Math.min(Math.abs(d1), Math.abs(d2)) > 0.1;
  }

  private blank(ts: number, mode: TwinMode, f: Features | null = null): TwinState {
    const p = this.params;
    return {
      ts, mode, learning: null, measured: f, expected: null, residuals: null, z: null,
      cusum: { pos: this.cusum.pos, neg: this.cusum.neg, h: this.cusum.h },
      loss: this.active ? { lpm: this.active.lossLpm, detected: true, kind: this.active.kind, classified: this.active.classified, since: this.active.since } : null,
      location: null, diagnosis: null,
      segments: {
        A: { state: this.active?.segment === 'A' ? this.active.kind : 'unknown' },
        B: { state: this.active?.segment === 'B' ? this.active.kind : 'unknown' },
      },
      model: p ? { pumpA: p.pumpA, pumpB: p.pumpB, RA: p.RA, RB: p.RB, Rout: p.Rout, c: p.c, learnedAt: p.learnedAt, samples: p.samples, RoutTracked: this.RoutTracked } : null,
      series: {},
    };
  }

  /** Sensors currently suspected by the integrity check (used by control safety interlocks). */
  get integrityAlert(): boolean {
    return this.integrityOpen;
  }
  get activeLoss(): Readonly<ActiveLoss> | null {
    return this.active;
  }
}

function locate2(l: { fA: number; fB: number }, LA: number, LB: number) {
  const cA = Math.min(Math.max(l.fA, 0), 1);
  const cB = Math.min(Math.max(l.fB, 0), 1);
  const segment: SegmentId = 1 - cA > cB ? 'A' : 'B';
  return { fA: l.fA, fB: l.fB, segment, positionM: segment === 'A' ? cA * LA : LA + cB * LB };
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export type { SensorId };
