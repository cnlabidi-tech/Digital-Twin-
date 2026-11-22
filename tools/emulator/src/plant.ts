/**
 * The emulated physical plant: hydraulics + dynamics + sensor electronics.
 *
 * Every tick (50 ms) it:
 *   1. ramps the pump duty and the tap openings (valves are turned by hand),
 *   2. solves the steady-state hydraulics for the current inputs,
 *   3. lets the "true" pressures/flows relax towards it (first-order lag),
 *   4. produces what the sensors physically output: ADS1115 counts for the
 *      pressure transducers, pulse counts for the YF-S201 flow meters,
 *      including noise, calibration errors and injected faults.
 * The device layer (device.ts) then converts these raw values exactly the way
 * the firmware will.
 */
import { DEFAULT_TOPOLOGY, type SensorId } from '@twin/contracts';
import { DEFAULT_HYDRAULICS, solve, type HydraulicParams, type Tap } from './hydraulics';

// ------------------------------------------------------------ sensor physics
/** Transducer: 0-10 bar -> 1-5 V, then a 2/3 divider, then ADS1115 at PGA +/-4.096 V. */
export const PRESSURE_ELEC = {
  vMin: 1,
  vMax: 5,
  rangeBar: 10,
  divider: 2 / 3,
  adcFullScaleV: 4.096,
  adcCounts: 32768,
};
/** YF-S201 nominal K-factor: pulse frequency (Hz) = 7.5 * flow (L/min). */
export const FLOW_K_NOMINAL = 7.5;
/** Below this flow the YF-S201 rotor does not turn (no pulses). */
export const FLOW_DEADBAND_LPM = 0.3;

export function barToCounts(bar: number, gain = 1, offsetBar = 0): number {
  const e = PRESSURE_ELEC;
  const v = e.vMin + ((bar * gain + offsetBar) / e.rangeBar) * (e.vMax - e.vMin);
  const vAdc = v * e.divider;
  return Math.max(-32768, Math.min(32767, Math.round((vAdc / e.adcFullScaleV) * e.adcCounts)));
}

/** Per-sensor imperfections (as found on real hardware; values are invented here). */
interface SensorCal {
  noise: number; // pressure: bar std-dev ; flow: relative std-dev
  gain: number; // pressure gain error, or flow true K-factor multiplier
  offset: number; // pressure offset error, bar
}
const SENSOR_CAL: Record<SensorId, SensorCal> = {
  P1: { noise: 0.03, gain: 1.0, offset: 0.01 }, // P1 sees more pump ripple
  P2: { noise: 0.015, gain: 1.005, offset: -0.015 },
  P3: { noise: 0.015, gain: 0.995, offset: 0.02 },
  F1: { noise: 0.02, gain: 1.0, offset: 0 },
  F2: { noise: 0.02, gain: 0.97, offset: 0 }, // F2 really gives 3 % fewer pulses: needs calibration
};

// -------------------------------------------------------------------- faults
export type FaultType = 'stuck' | 'drift' | 'disconnected' | 'noisy';
export interface Fault {
  id: string;
  sensor: SensorId;
  type: FaultType;
  /** drift: bar (or L/min) per minute ; noisy: extra std-dev. */
  magnitude?: number;
  startedAt: number;
  frozenRaw?: number;
}

// --------------------------------------------------------------------- plant
export interface PlantTruth {
  t: number;
  pumpOn: boolean;
  dutyCmd: number; // 0..100 commanded
  dutyEff: number; // 0..1 effective (after soft-start)
  outletOpening: number;
  pressure: Record<'P1' | 'P2' | 'P3', number>;
  flow: Record<'F1' | 'F2', number>;
  tapFlows: Record<string, number>;
}

export interface TapSpec extends Omit<Tap, 'opening'> {
  /** Seconds to go from closed to fully open (0 = sudden). */
  rampS: number;
  target: number; // 0..1 final opening
  opening: number;
}

const gauss = () => {
  // Box-Muller transform: standard normal random number.
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export class Plant {
  readonly hyd: HydraulicParams;
  private readonly tauS = 0.4; // hydraulic settling time constant
  private readonly softStartS = 0.8; // pump spin-up time

  pumpOn = true;
  dutyCmd = 100;
  private dutyEff = 0;
  outletOpening = 1;
  taps = new Map<string, TapSpec>();
  faults = new Map<string, Fault>();

  private pressure = { P1: 0, P2: 0, P3: 0 };
  private flow = { F1: 0, F2: 0 };
  private tapFlows: Record<string, number> = {};
  /** Cumulative (fractional) pulses per flow meter since "boot". */
  private pulses = { F1: 0, F2: 0 };
  private driftAcc: Partial<Record<SensorId, number>> = {};
  private t = 0;

  constructor(hyd: Partial<HydraulicParams> = {}) {
    this.hyd = { ...DEFAULT_HYDRAULICS, ...hyd };
  }

  /** Advance the physics by dt seconds. */
  step(dt: number): void {
    this.t += dt;
    // 1. actuator & valve dynamics
    const dutyTarget = this.pumpOn ? this.dutyCmd / 100 : 0;
    const rate = dt / this.softStartS;
    this.dutyEff += Math.max(-rate * 3, Math.min(rate, dutyTarget - this.dutyEff)); // stops faster than it starts
    for (const tap of this.taps.values()) {
      const r = tap.rampS > 0 ? dt / tap.rampS : 1;
      tap.opening += Math.max(-r, Math.min(r, tap.target - tap.opening));
    }
    // 2. steady state for current inputs
    const pos = DEFAULT_TOPOLOGY.positionsM;
    const op = solve(this.dutyEff, this.outletOpening, [...this.taps.values()], pos, this.hyd);
    // 3. first-order lag towards steady state
    const a = 1 - Math.exp(-dt / this.tauS);
    for (const k of ['P1', 'P2', 'P3'] as const) this.pressure[k] += a * ((op.pressureAt[k] ?? 0) - this.pressure[k]);
    for (const k of ['F1', 'F2'] as const) this.flow[k] += a * ((op.flowAt[k] ?? 0) - this.flow[k]);
    this.tapFlows = op.tapFlows;
    // 4. flow meters accumulate pulses (true K-factor differs per sensor)
    for (const k of ['F1', 'F2'] as const) {
      const q = this.flow[k] * (1 + SENSOR_CAL[k].noise * gauss());
      if (q > FLOW_DEADBAND_LPM) this.pulses[k] += FLOW_K_NOMINAL * SENSOR_CAL[k].gain * q * dt;
    }
    for (const f of this.faults.values()) {
      if (f.type === 'drift') this.driftAcc[f.sensor] = (this.driftAcc[f.sensor] ?? 0) + ((f.magnitude ?? 0.1) * dt) / 60;
    }
  }

  /** One instantaneous ADS1115 reading of a pressure transducer (counts). */
  readPressureCounts(id: 'P1' | 'P2' | 'P3'): number {
    const cal = SENSOR_CAL[id];
    const fault = this.faultFor(id);
    if (fault?.type === 'disconnected') return Math.round(gauss() * 3); // input floating near 0 V
    let bar = this.pressure[id] + cal.noise * gauss() * (this.dutyEff > 0 ? 1 : 0.2);
    if (fault?.type === 'noisy') bar += (fault.magnitude ?? 0.3) * gauss();
    if (fault?.type === 'drift') bar += this.driftAcc[id] ?? 0;
    const counts = barToCounts(Math.max(bar, -0.2), cal.gain, cal.offset);
    if (fault?.type === 'stuck') return (fault.frozenRaw ??= counts);
    return counts;
  }

  /** Cumulative pulse counter of a flow meter (what the GPIO interrupt counts). */
  readPulseCount(id: 'F1' | 'F2'): number {
    const fault = this.faultFor(id);
    const total = Math.floor(this.pulses[id]);
    if (fault?.type === 'stuck' || fault?.type === 'disconnected') return (fault.frozenRaw ??= total);
    return total;
  }

  private faultFor(id: SensorId): Fault | undefined {
    for (const f of this.faults.values()) if (f.sensor === id) return f;
    return undefined;
  }

  truth(): PlantTruth {
    return {
      t: this.t,
      pumpOn: this.pumpOn,
      dutyCmd: this.dutyCmd,
      dutyEff: this.dutyEff,
      outletOpening: this.outletOpening,
      pressure: { ...this.pressure },
      flow: { ...this.flow },
      tapFlows: { ...this.tapFlows },
    };
  }

  /** Reset all injected conditions (pump state is kept). */
  clearInjections(): void {
    this.taps.clear();
    this.faults.clear();
    this.driftAcc = {};
    this.outletOpening = 1;
  }
}
