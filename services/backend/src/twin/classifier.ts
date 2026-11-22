/**
 * Leak vs theft classification.
 *
 * Physically both are a loss of fluid through an opening, so the pressure
 * signature alone cannot separate them. We use HOW the loss appears and behaves:
 *
 *  - Onset shape: a leak (crack, burst, failed joint) appears abruptly: the
 *    loss reaches its level in about one sensor window. Illegal tapping is a
 *    deliberate act: a valve is opened by hand, the loss ramps up over
 *    several seconds.
 *  - Recurrence: a thief opens and closes the tap repeatedly; a loss that
 *    stops BY ITSELF (pump still running) and reappears at the same place is
 *    classified as theft. A leak repaired after a pump stop does not count.
 *
 * Rise time is measured on the 4-second loss signal, between 20 % and 80 % of
 * the final level. This is a heuristic with explicit assumptions, documented
 * as such in the thesis (limits: a slowly growing crack would look like theft;
 * a thief who opens the valve in one quick move looks like a leak).
 */
/**
 * Measured on the 4-s window loss, between 20 % and 80 % of the level: an
 * instantaneous step appears as a 4-s linear ramp => ~2.4 s. A valve opened
 * over 10 s gives ~7-8 s. Threshold in between.
 */
export const RISE_TIME_THEFT_S = 5;
export const RECURRENCE_WINDOW_MS = 10 * 60_000;
export const RECURRENCE_DISTANCE_M = 0.6;

export interface OnsetPoint {
  ts: number;
  loss: number;
}

/** Rise time (s) of the loss between 20 % and 80 % of `level`. */
export function riseTime(history: OnsetPoint[], baseline: number, level: number): number | null {
  const amp = level - baseline;
  if (amp <= 0 || history.length < 3) return null;
  const t90 = history.find((p) => p.loss - baseline >= 0.8 * amp)?.ts;
  if (t90 === undefined) return null;
  // last sample before t90 that was still below 10 %
  let t10: number | undefined;
  for (const p of history) {
    if (p.ts > t90) break;
    if (p.loss - baseline <= 0.2 * amp) t10 = p.ts;
  }
  if (t10 === undefined) return null;
  return (t90 - t10) / 1000;
}

export interface PastLoss {
  resolvedAt: number;
  positionM: number | null;
}

export function classify(
  rise: number | null,
  positionM: number | null,
  past: PastLoss[],
  now: number,
): { kind: 'leak' | 'theft'; reason: string } {
  const recurrent = past.some(
    (p) =>
      now - p.resolvedAt < RECURRENCE_WINDOW_MS &&
      (p.positionM === null || positionM === null || Math.abs(p.positionM - positionM) < RECURRENCE_DISTANCE_M),
  );
  if (recurrent) return { kind: 'theft', reason: 'loss reappeared at the same place (intermittent tapping)' };
  if (rise !== null && rise >= RISE_TIME_THEFT_S) return { kind: 'theft', reason: `gradual onset (rise ${rise.toFixed(1)} s): valve opened by hand` };
  if (rise !== null) return { kind: 'leak', reason: `abrupt onset (rise ${rise.toFixed(1)} s)` };
  return { kind: 'leak', reason: 'onset not measurable, assumed leak' };
}
