/**
 * Conversion logic that the REAL firmware (Phase 7) will implement in C++.
 * Kept separate so the C++ port can be checked line by line against it.
 *
 *  - Pressure: oversample the ADS1115 during the window, average the counts,
 *    convert counts -> volts -> bar. Below 0.9 V the 4-20/1-5 V loop is broken
 *    (live-zero principle) => quality "out_of_range", value null.
 *  - Flow: read the cumulative pulse counter; flow = delta pulses / window / K.
 */
import type { SensorReading } from '@twin/contracts';
import { FLOW_K_NOMINAL, PRESSURE_ELEC } from './plant';

/** Calibration constants stored in the firmware (NVS); refined in Phase 8. */
export interface FirmwareCal {
  pressureOffsetBar: number;
  pressureGain: number;
  flowK: number; // pulses per second per L/min
}
export const DEFAULT_FW_CAL: FirmwareCal = { pressureOffsetBar: 0, pressureGain: 1, flowK: FLOW_K_NOMINAL };

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function countsToReading(avgCounts: number, cal: FirmwareCal = DEFAULT_FW_CAL): SensorReading {
  const e = PRESSURE_ELEC;
  const vAdc = (avgCounts * e.adcFullScaleV) / e.adcCounts;
  const vSensor = vAdc / e.divider;
  const raw = Math.round(avgCounts);
  if (vSensor < e.vMin - 0.1) return { v: null, raw, q: 'out_of_range' };
  if (vSensor > e.vMax + 0.1) return { v: null, raw, q: 'out_of_range' };
  const bar = ((vSensor - e.vMin) / (e.vMax - e.vMin)) * e.rangeBar;
  return { v: round(bar * cal.pressureGain + cal.pressureOffsetBar, 3), raw, q: 'ok' };
}

export function pulsesToReading(
  totalNow: number,
  totalPrev: number,
  windowS: number,
  cal: FirmwareCal = DEFAULT_FW_CAL,
): SensorReading {
  const delta = totalNow - totalPrev;
  const lpm = windowS > 0 ? delta / windowS / cal.flowK : 0;
  return { v: round(Math.max(lpm, 0), 3), raw: totalNow, q: 'ok' };
}

/** Accumulates oversampled ADC values over one telemetry window. */
export class WindowAverager {
  private sum = 0;
  private n = 0;
  add(x: number): void {
    this.sum += x;
    this.n += 1;
  }
  /** Returns the average and resets the window. */
  take(): number {
    const avg = this.n ? this.sum / this.n : 0;
    this.sum = 0;
    this.n = 0;
    return avg;
  }
}
