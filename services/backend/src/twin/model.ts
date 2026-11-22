/**
 * Hydraulic model of the pipe: the "physics" part of the digital twin.
 *
 * Relations (all quadratic in flow, turbulent regime):
 *   Pump curve     P1 = a * d^2 - b * F1^2          d = PWM duty (affinity law)
 *   Segment A      P1 - P2 = RA * Q_A^2             Q_A = flow through A
 *   Segment B      P2 - P3 = RB * Q_B^2
 *   Outlet         P3 = Rout * F2^2                 Rout depends on the outlet valve
 *   Mass balance   F1 = c * F2                      c = flow-meter calibration ratio
 *
 * The parameters are NOT assumed: they are identified from data recorded
 * while the pipe is known to be healthy (baseline / commissioning).
 * Least squares through the origin:  R = sum(dP * Q^2) / sum(Q^4).
 */
import type { Features } from './features';

export interface ModelParams {
  /** Pump: shut-off pressure at 100 % duty (bar) and curve coefficient (bar / (L/min)^2). */
  pumpA: number;
  pumpB: number;
  RA: number;
  RB: number;
  /** Outlet coefficient at learning time (tracked online afterwards). */
  Rout: number;
  /** Flow-meter ratio F1/F2 in healthy conditions. */
  c: number;
  /** Residual noise (standard deviation) of each residual in healthy conditions. */
  sigma: Record<ResidualName, number>;
  /** Residual mean in healthy conditions (bias removed before thresholding). */
  mu: Record<ResidualName, number>;
  /** Operating point at learning (for reports). */
  nominal: { F1: number; P1: number; P2: number; P3: number };
  samples: number;
  learnedAt: number;
}

export const RESIDUALS = ['mass', 'pump', 'outlet', 'segA', 'segB', 'total'] as const;
export type ResidualName = (typeof RESIDUALS)[number];

/** Datasheet prior for the pump curve shape: 8 bar shut-off, 5 L/min free flow => b = 8/25. */
export const PUMP_B_PRIOR = 8 / 25;

/** Lower bounds on sigma so that an unusually quiet baseline does not make thresholds too tight. */
export const SIGMA_FLOOR: Record<ResidualName, number> = {
  mass: 0.03, pump: 0.03, outlet: 0.05, segA: 0.015, segB: 0.015, total: 0.02,
};

/** Fit model parameters from healthy steady-state feature vectors. */
export function fitModel(samples: Features[]): ModelParams {
  if (samples.length < 10) throw new Error('not enough samples to learn the model');
  const sum = (f: (s: Features) => number) => samples.reduce((acc, s) => acc + f(s), 0);
  // Flow-meter ratio first: all downstream flows are then expressed on F1's scale.
  const c = sum((s) => s.F1) / sum((s) => s.F2);
  const q2 = (s: Features) => (c * s.F2) ** 2;
  const RA = sum((s) => (s.P1 - s.P2) * s.F1 ** 2) / sum((s) => s.F1 ** 4);
  const RB = sum((s) => (s.P2 - s.P3) * q2(s)) / sum((s) => q2(s) ** 2);
  const Rout = sum((s) => s.P3 * q2(s)) / sum((s) => q2(s) ** 2);

  // Pump curve: if the flow varied enough during learning, fit both a and b;
  // otherwise keep the datasheet shape b and fit only a.
  const d2 = (s: Features) => (s.duty / 100) ** 2;
  const f1s = samples.map((s) => s.F1);
  let pumpB = PUMP_B_PRIOR;
  let pumpA: number;
  if (Math.max(...f1s) - Math.min(...f1s) > 0.6) {
    // linear LS on P1 = a*d^2 - b*F1^2
    const n = samples.length;
    const x1 = samples.map(d2);
    const x2 = samples.map((s) => -(s.F1 ** 2));
    const y = samples.map((s) => s.P1);
    const s11 = x1.reduce((a, v) => a + v * v, 0);
    const s22 = x2.reduce((a, v) => a + v * v, 0);
    const s12 = x1.reduce((a, v, i) => a + v * x2[i]!, 0);
    const s1y = x1.reduce((a, v, i) => a + v * y[i]!, 0);
    const s2y = x2.reduce((a, v, i) => a + v * y[i]!, 0);
    const det = s11 * s22 - s12 * s12;
    pumpA = (s1y * s22 - s2y * s12) / det;
    pumpB = (s11 * s2y - s12 * s1y) / det;
    if (!(pumpB > 0) || n < 20) {
      pumpB = PUMP_B_PRIOR;
      pumpA = sum((s) => s.P1 + pumpB * s.F1 ** 2) / sum(d2);
    }
  } else {
    pumpA = sum((s) => (s.P1 + pumpB * s.F1 ** 2) * d2(s)) / sum((s) => d2(s) ** 2);
  }

  const partial = { pumpA, pumpB, RA, RB, Rout, c };
  const rs = samples.map((s) => residuals(s, partial, Rout));
  const mu = {} as Record<ResidualName, number>;
  const sigma = {} as Record<ResidualName, number>;
  for (const k of RESIDUALS) {
    const xs = rs.map((r) => r[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    mu[k] = m;
    sigma[k] = Math.max(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)), SIGMA_FLOOR[k]);
  }
  const avg = (f: (s: Features) => number) => sum(f) / samples.length;
  return {
    ...partial,
    sigma,
    mu,
    nominal: { F1: avg((s) => s.F1), P1: avg((s) => s.P1), P2: avg((s) => s.P2), P3: avg((s) => s.P3) },
    samples: samples.length,
    learnedAt: Date.now(),
  };
}

/**
 * Analytical-redundancy residuals: each is ~0 when the physics holds.
 * Every sensor appears in at least two relations, which is what allows us to
 * tell a real leak from a faulty or forged sensor (see diagnosis.ts).
 */
export function residuals(
  f: Pick<Features, 'P1' | 'P2' | 'P3' | 'F1' | 'F2' | 'duty'>,
  p: Pick<ModelParams, 'pumpA' | 'pumpB' | 'RA' | 'RB' | 'c'>,
  Rout: number,
): Record<ResidualName, number> {
  const d2 = (f.duty / 100) ** 2;
  return {
    mass: f.F1 - p.c * f.F2, // L/min : >0 = fluid lost between F1 and F2
    pump: f.P1 - (p.pumpA * d2 - p.pumpB * f.F1 ** 2), // bar : P1/F1 consistency
    outlet: f.P3 - Rout * (p.c * f.F2) ** 2, // bar : P3/F2 consistency
    segA: f.P1 - f.P2 - p.RA * f.F1 ** 2, // bar : 0 unless leak in A (or bad P1/P2/F1)
    segB: f.P2 - f.P3 - p.RB * (p.c * f.F2) ** 2, // bar : 0 unless leak in B
    // P2 does not appear here: used to isolate a faulty P2.
    total: f.P1 - f.P3 - p.RA * f.F1 ** 2 - p.RB * (p.c * f.F2) ** 2,
  };
}

/** Expected (model) values of the downstream sensors given the inlet measurements. */
export function expected(f: Pick<Features, 'P1' | 'F1' | 'duty'>, p: ModelParams, Rout: number) {
  const F2 = f.F1 / p.c;
  const P2 = f.P1 - p.RA * f.F1 ** 2;
  const P3 = P2 - p.RB * f.F1 ** 2;
  return {
    F2,
    P2,
    P3,
    P3fromOutlet: Rout * f.F1 ** 2,
    P1fromPump: p.pumpA * (f.duty / 100) ** 2 - p.pumpB * f.F1 ** 2,
  };
}

/**
 * Leak localisation by hydraulic-gradient interpolation.
 *
 * With a leak of flow q at relative position x in segment A:
 *   P1 - P2 = RA * (x * F1^2 + (1 - x) * F2^2)   and   P2 - P3 = RB * F2^2
 * so  fA = ((P1-P2)/RA - F2^2) / (F1^2 - F2^2) = x   and   fB = 0.
 * With the leak at y in segment B:  fA = 1  and  fB = y.
 * Hence ONE formula for both cases:  position = fA * LA + fB * LB.
 * fA, fB far outside [0, 1] are physically impossible => inconsistent data.
 */
export function locate(
  f: Pick<Features, 'P1' | 'P2' | 'P3' | 'F1' | 'F2'>,
  p: Pick<ModelParams, 'RA' | 'RB' | 'c' | 'mu'>,
  LA: number,
  LB: number,
): { fA: number; fB: number; positionM: number; segment: 'A' | 'B'; den: number } | null {
  const q1 = f.F1 ** 2;
  const q2 = (p.c * f.F2) ** 2;
  const den = q1 - q2;
  if (den < 0.4) return null; // loss too small for a meaningful position
  // Pressure drops corrected by the healthy-state bias (sensor offsets).
  const dA = f.P1 - f.P2 - p.mu.segA;
  const dB = f.P2 - f.P3 - p.mu.segB;
  const fA = (dA / p.RA - q2) / den;
  const fB = (dB / p.RB - q2) / den;
  const cA = Math.min(Math.max(fA, 0), 1);
  const cB = Math.min(Math.max(fB, 0), 1);
  // Decide the segment from the larger "evidence": a leak in A gives fA<1, fB~0.
  const segment: 'A' | 'B' = 1 - cA > cB ? 'A' : 'B';
  const positionM = segment === 'A' ? cA * LA : LA + cB * LB;
  return { fA, fB, positionM, segment, den };
}
