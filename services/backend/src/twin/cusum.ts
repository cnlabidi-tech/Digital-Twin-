/**
 * Two-sided CUSUM (Page, 1954) on a standardised residual z.
 *
 *   S+ = max(0, S+ + z - k)      accumulates persistent POSITIVE shifts (fluid loss)
 *   S- = max(0, S- - z - k)      accumulates persistent NEGATIVE shifts (fluid "gain":
 *                                physically impossible => sensor fault or forged data)
 *   alarm when S > h
 *
 * k (reference value) ~ half the shift we want to detect, in sigmas.
 * h (decision interval) trades detection delay against false-alarm rate.
 * A plain threshold reacts only to large residuals; CUSUM sums small ones, so
 * a leak of ~1-2 sigma is still detected after enough samples.
 */
export class Cusum {
  pos = 0;
  neg = 0;

  constructor(
    public k = 0.5,
    public h = 12,
    /** z is clipped to +/- clip so one outlier cannot trigger an alarm alone. */
    public clip = 6,
  ) {}

  update(z: number): { pos: number; neg: number; alarmPos: boolean; alarmNeg: boolean } {
    const zc = Math.max(-this.clip, Math.min(this.clip, z));
    this.pos = Math.max(0, this.pos + zc - this.k);
    this.neg = Math.max(0, this.neg - zc - this.k);
    return { pos: this.pos, neg: this.neg, alarmPos: this.pos > this.h, alarmNeg: this.neg > this.h };
  }

  reset(): void {
    this.pos = 0;
    this.neg = 0;
  }
}
