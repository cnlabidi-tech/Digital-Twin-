/**
 * Temporal plausibility checks per sensor - the second half of false-data-
 * injection detection (the first half is the twin's physical consistency).
 * These catch forged data that is "correctly signed" (compromised device):
 *
 *  frozen      real transducers always show noise; a value that does not
 *              change at all for 10 s while the pump runs is stuck or forged.
 *  replayed    real noise never repeats: if the last 12 values reappear
 *              exactly, in the same order, earlier in the last 3 minutes, the
 *              data is a recorded loop (classic "replay what looks normal").
 *  jump        physically impossible step between two samples (> 2.5 bar or
 *              > 3 L/min in one sample while the pump state did not change).
 *  raw/value   the engineering value must match its own raw measurement
 *              (ADC counts -> bar, pulse delta -> L/min). A naive attacker
 *              changes only the value.
 */
import { SENSORS, type SensorId, type Telemetry } from '@twin/contracts';

const ELEC = { vMin: 1, vMax: 5, range: 10, divider: 2 / 3, fs: 4.096, counts: 32768 };
const FLOW_K = 7.5;

export interface PlausibilityFinding {
  sensorId: SensorId;
  check: 'frozen' | 'replayed' | 'jump' | 'raw_mismatch';
  message: string;
}

interface Hist {
  ts: number[];
  v: (number | null)[];
  raw: number[];
  bootId: string;
}

export class PlausibilityChecker {
  private hist = new Map<SensorId, Hist>();
  private lastPump: boolean | undefined;
  private lastPumpChange = 0;

  /** Returns current findings for the sensors in this message. */
  check(t: Telemetry): PlausibilityFinding[] {
    const out: PlausibilityFinding[] = [];
    if (t.actuators?.pump) {
      // first sight of the pump, or a change: the next 10 s are not "steady"
      if (this.lastPump === undefined || this.lastPump !== t.actuators.pump.on) this.lastPumpChange = t.ts;
      this.lastPump = t.actuators.pump.on;
    }
    const pumpSteady = this.lastPump === true && t.ts - this.lastPumpChange > 10_000;

    for (const [id, r] of Object.entries(t.sensors) as [SensorId, Telemetry['sensors'][string]][]) {
      const spec = SENSORS[id];
      let h = this.hist.get(id);
      if (!h || h.bootId !== t.bootId) this.hist.set(id, (h = { ts: [], v: [], raw: [], bootId: t.bootId }));
      const prevV = h.v[h.v.length - 1];
      const prevRaw = h.raw[h.raw.length - 1];
      const prevTs = h.ts[h.ts.length - 1];
      h.ts.push(t.ts);
      h.v.push(r.v);
      h.raw.push(r.raw);
      while (h.ts.length && h.ts[0]! < t.ts - 180_000) {
        h.ts.shift();
        h.v.shift();
        h.raw.shift();
      }
      if (r.v === null || r.q !== 'ok') continue;

      // raw / value consistency
      if (spec.kind === 'pressure') {
        const bar = (((r.raw * ELEC.fs) / ELEC.counts / ELEC.divider - ELEC.vMin) / (ELEC.vMax - ELEC.vMin)) * ELEC.range;
        // allow calibration offset/gain applied by the firmware (±0.3 bar, ±5 %)
        if (Math.abs(bar - r.v) > 0.3 + 0.05 * Math.abs(r.v)) {
          out.push({ sensorId: id, check: 'raw_mismatch', message: `${id}=${r.v} bar but its ADC reading means ${bar.toFixed(2)} bar` });
        }
      } else if (prevRaw !== undefined && prevTs !== undefined && t.ts > prevTs) {
        const lpm = (r.raw - prevRaw) / FLOW_K / ((t.ts - prevTs) / 1000);
        // pulse quantisation over 0.5 s = 0.27 L/min; allow 2 pulses + 15 % (K calibration)
        if (Math.abs(lpm - r.v) > 0.6 + 0.15 * Math.abs(r.v)) {
          out.push({ sensorId: id, check: 'raw_mismatch', message: `${id}=${r.v} L/min but its pulse counter means ${lpm.toFixed(2)} L/min` });
        }
      }

      // impossible jump
      const maxJump = spec.kind === 'pressure' ? 2.5 : 3;
      if (pumpSteady && typeof prevV === 'number' && Math.abs(r.v - prevV) > maxJump) {
        out.push({ sensorId: id, check: 'jump', message: `${id} jumped ${prevV} -> ${r.v} in one sample` });
      }

      // frozen (pressure only: a stopped flow meter legitimately reads exactly 0)
      if (spec.kind === 'pressure' && pumpSteady) {
        const recent = h.v.filter((_, i) => h!.ts[i]! >= t.ts - 10_000);
        if (recent.length >= 15 && recent.every((v) => v === r.v)) {
          out.push({ sensorId: id, check: 'frozen', message: `${id} constant at ${r.v} for 10 s while the pump runs (real sensors are noisy)` });
        }
      }

      // replayed loop
      if (pumpSteady && h.v.length > 60) {
        const L = 12;
        const tail = h.v.slice(-L);
        const varied = new Set(tail).size > 3; // ignore flat signals (covered by "frozen")
        if (varied) {
          for (let start = 0; start + L < h.v.length - L; start++) {
            let same = true;
            for (let k = 0; k < L && same; k++) same = h.v[start + k] === tail[k];
            if (same) {
              out.push({ sensorId: id, check: 'replayed', message: `${id}: the last ${L} values repeat a sequence recorded ${Math.round((t.ts - h.ts[start]!) / 1000)} s earlier` });
              break;
            }
          }
        }
      }
    }
    return out;
  }
}
