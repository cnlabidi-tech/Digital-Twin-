/**
 * Diagnosis by structured residuals (fault-signature matrix).
 *
 * Which sensors each relation uses:
 *
 *              P1  P2  P3  F1  F2     holds during a real leak?
 *   mass        .   .   .   x   x     NO  (that is how we see the leak)
 *   pump        x   .   .   x   .     YES (pump only sees its own P1/F1)
 *   outlet      .   .   x   .   x     YES (outlet only sees its own P3/F2)
 *   segA        x   x   .   x   .     no if the leak is in A
 *   segB        .   x   x   .   x     no if the leak is in B
 *   total       x   .   x   x   x     within physical bounds (localisation fA, fB in [0,1])
 *
 * Decision:
 *  1. Fluid loss (mass > 0) AND pump, outlet hold AND the localisation is
 *     physically possible  ->  REAL LOSS (leak or theft), located.
 *  2. Any relation that must hold is violated, or negative mass ("fluid
 *     created"), or impossible localisation -> DATA INCONSISTENT: sensor fault
 *     or FALSE DATA INJECTION. Suspect sensors = those in the most violated
 *     relations and in no satisfied relation.
 * This is how the twin refuses to be fooled by one forged sensor: an attacker
 * must forge several sensors on two different devices consistently with the
 * physics, which is far harder.
 */
import type { SensorId } from '@twin/contracts';
import type { ResidualName } from './model';

export const RELATION_SENSORS: Record<ResidualName, SensorId[]> = {
  mass: ['F1', 'F2'],
  pump: ['P1', 'F1'],
  outlet: ['P3', 'F2'],
  segA: ['P1', 'P2', 'F1'],
  segB: ['P2', 'P3', 'F2'],
  total: ['P1', 'P3', 'F1', 'F2'],
};

export const Z_VIOLATION = 5; // |z| above this = relation violated
export const LOC_TOLERANCE = 0.35; // fA, fB allowed slightly outside [0,1] (noise)

export type Hypothesis = 'healthy' | 'loss' | 'inconsistent';

export interface Diagnosis {
  hypothesis: Hypothesis;
  violated: ResidualName[];
  suspects: SensorId[];
  reasons: string[];
}

/**
 * `loc.tolA/tolB`: how far fA/fB may lie outside [0, 1] before the profile is
 * called impossible. It grows with the uncertainty of the estimate (small
 * losses => small F1^2 - F2^2 => noisy fA/fB), never below LOC_TOLERANCE.
 */
export function diagnose(
  z: Record<ResidualName, number>,
  lossDetected: boolean,
  gainDetected: boolean,
  loc: { fA: number; fB: number; tolA?: number; tolB?: number } | null,
): Diagnosis {
  const violated = (Object.keys(z) as ResidualName[]).filter((k) => Math.abs(z[k]) > Z_VIOLATION);
  const reasons: string[] = [];

  // Relations that must hold whatever happens to the pipe.
  const mustHold: ResidualName[] = lossDetected ? ['pump', 'outlet'] : ['pump', 'outlet', 'segA', 'segB', 'total', 'mass'];
  const broken = mustHold.filter((k) => violated.includes(k));
  for (const k of broken) reasons.push(`${k} relation violated (z=${z[k].toFixed(1)})`);

  if (gainDetected || z.mass < -Z_VIOLATION) reasons.push('outlet flow exceeds inlet flow (fluid created)');
  let locBad = false;
  if (lossDetected && loc) {
    const out = (f: number, tol = LOC_TOLERANCE) => f < -tol || f > 1 + tol;
    if (out(loc.fA, loc.tolA) || out(loc.fB, loc.tolB)) {
      locBad = true;
      reasons.push(`pressure profile impossible for a loss (fA=${loc.fA.toFixed(2)}, fB=${loc.fB.toFixed(2)})`);
    }
  }

  if (!reasons.length) {
    return { hypothesis: lossDetected ? 'loss' : 'healthy', violated, suspects: [], reasons: [] };
  }

  // Isolation (consistency-based diagnosis with exoneration):
  //  - every violated relation must be explained by at least one faulty sensor,
  //  - a sensor used by a SATISFIED must-hold relation is exonerated,
  //  - prefer a single sensor explaining all violations (minimal explanation).
  const conflicts: SensorId[][] = broken.map((k) => RELATION_SENSORS[k]);
  if (gainDetected || z.mass < -Z_VIOLATION) conflicts.push(RELATION_SENSORS.mass);
  if (locBad) conflicts.push(['P1', 'P2', 'P3']);
  const exonerated = new Set<SensorId>(mustHold.filter((k) => !violated.includes(k)).flatMap((k) => RELATION_SENSORS[k]));
  let candidates = [...new Set(conflicts.flat())].filter((s) => !exonerated.has(s));
  if (!candidates.length) candidates = [...new Set(conflicts.flat())];
  // In a loss situation one of F1/F2 must be involved if the loss itself is fake.
  if (lossDetected && candidates.some((c) => c === 'F1' || c === 'F2') && broken.length) {
    const flow = candidates.filter((c) => c === 'F1' || c === 'F2');
    if (flow.length === 1) candidates = flow;
  }
  const single = candidates.filter((c) => conflicts.every((set) => set.includes(c)));
  const suspects = single.length ? single : candidates;
  return { hypothesis: 'inconsistent', violated, suspects, reasons };
}
