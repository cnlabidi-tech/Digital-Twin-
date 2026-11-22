/**
 * Attack injection.
 *
 * Two families, matching two different threat models:
 *
 * A. FALSE DATA INJECTION by a COMPROMISED DEVICE (applied BEFORE signing).
 *    The attacker controls the firmware or the sensor wiring, so messages are
 *    correctly signed and fresh: cryptography CANNOT detect them. Only the
 *    twin's physical-consistency checks can (Phase 4/6). Types:
 *      fdi_bias    add a constant to a sensor
 *      fdi_scale   multiply a sensor
 *      fdi_freeze  hold a sensor at its value when the attack started
 *      fdi_ramp    slowly growing bias (stealthy)
 *      fdi_replay  record N seconds of normal readings, then loop them
 *                  (Stuxnet-style "everything looks normal")
 *    By default the attacker keeps `raw` consistent with `v` (smart attacker);
 *    with naive=true only `v` is changed.
 *
 * B. NETWORK ATTACKS by an OUTSIDER (applied AFTER signing, on the wire).
 *      tamper   change a value in the signed message  -> signature breaks
 *      replay   record raw messages, then send them instead of live ones
 *               -> old timestamps / reused nonces
 *      spoof    send fabricated messages signed with a wrong key
 *      drop     suppress telemetry (jamming / DoS of the link)
 */
import { DEVICE_SENSORS, SENSORS, type DeviceId, type SensorId, type Telemetry } from '@twin/contracts';
import { barToCounts, FLOW_K_NOMINAL } from './plant';

export const FDI_TYPES = ['fdi_bias', 'fdi_scale', 'fdi_freeze', 'fdi_ramp', 'fdi_replay'] as const;
export const NET_TYPES = ['tamper', 'replay', 'spoof', 'drop'] as const;
export type AttackType = (typeof FDI_TYPES)[number] | (typeof NET_TYPES)[number];

export interface AttackSpec {
  type: AttackType;
  /** Target sensor (FDI, tamper). The device is derived from it. */
  sensor?: SensorId;
  /** Target device (replay, spoof, drop, or fdi_replay on all its sensors). */
  device?: DeviceId;
  delta?: number; // fdi_bias, tamper
  factor?: number; // fdi_scale
  ratePerS?: number; // fdi_ramp
  recordS?: number; // fdi_replay, replay
  naive?: boolean;
}

export interface Attack extends AttackSpec {
  id: string;
  device: DeviceId;
  startedAt: number;
  // internal state
  frozen?: Partial<Record<SensorId, number>>;
  recorded?: Array<Record<string, number | null>>;
  recordedRaw?: string[];
  playIdx?: number;
  fakePulses?: Partial<Record<SensorId, number>>;
}

export function createAttack(id: string, spec: AttackSpec, now: number): Attack {
  const device = spec.device ?? (spec.sensor ? SENSORS[spec.sensor].device : undefined);
  if (!device) throw new Error('attack needs a "sensor" or a "device"');
  if ((FDI_TYPES as readonly string[]).includes(spec.type) && spec.type !== 'fdi_replay' && !spec.sensor) {
    throw new Error(`${spec.type} needs a "sensor"`);
  }
  if (spec.type === 'tamper' && !spec.sensor) throw new Error('tamper needs a "sensor"');
  if (![...FDI_TYPES, ...NET_TYPES].includes(spec.type)) throw new Error(`unknown attack type ${spec.type}`);
  return { ...spec, id, device, startedAt: now };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Apply family-A attacks to a telemetry object (before it is signed). */
export function applyFdi(t: Telemetry, attacks: Attack[], now: number): void {
  for (const a of attacks) {
    if (a.device !== t.deviceId || !(FDI_TYPES as readonly string[]).includes(a.type)) continue;
    const targets: SensorId[] = a.sensor ? [a.sensor] : DEVICE_SENSORS[t.deviceId];

    if (a.type === 'fdi_replay') {
      const recS = a.recordS ?? 20;
      const snapshot = Object.fromEntries(targets.map((s) => [s, t.sensors[s]?.v ?? null]));
      if (now - a.startedAt < recS * 1000) {
        (a.recorded ??= []).push(snapshot); // recording phase: pass through unchanged
        continue;
      }
      const rec = a.recorded ?? [];
      if (!rec.length) continue;
      const frame = rec[(a.playIdx = ((a.playIdx ?? -1) + 1) % rec.length)]!;
      for (const s of targets) setValue(t, a, s, frame[s] ?? null);
      continue;
    }

    for (const s of targets) {
      const r = t.sensors[s];
      if (!r || r.v === null) continue;
      let v = r.v;
      if (a.type === 'fdi_bias') v += a.delta ?? 0;
      if (a.type === 'fdi_scale') v *= a.factor ?? 1;
      if (a.type === 'fdi_freeze') v = (a.frozen ??= {})[s] ??= v;
      if (a.type === 'fdi_ramp') v += ((now - a.startedAt) / 1000) * (a.ratePerS ?? 0.01);
      setValue(t, a, s, v);
    }
  }
}

/** Write a fake value; a smart attacker also forges a matching `raw`. */
function setValue(t: Telemetry, a: Attack, s: SensorId, v: number | null): void {
  const r = t.sensors[s];
  if (!r) return;
  const realRaw = r.raw;
  r.v = v === null ? null : r3(Math.max(v, 0));
  if (a.naive || r.v === null) return;
  if (SENSORS[s].kind === 'pressure') {
    r.raw = barToCounts(r.v);
  } else {
    // keep a fake cumulative pulse counter consistent with the fake flow
    const fp = (a.fakePulses ??= {});
    fp[s] = Math.round((fp[s] ?? realRaw) + r.v * FLOW_K_NOMINAL * (t.intervalMs / 1000));
    r.raw = fp[s]!;
  }
}

/**
 * Apply family-B attacks to a signed raw message.
 * Returns the list of raw messages to actually send (possibly empty or replaced).
 */
export function applyNetwork(deviceId: DeviceId, raw: string, attacks: Attack[], now: number): string[] {
  let out = [raw];
  for (const a of attacks) {
    if (a.device !== deviceId) continue;
    if (a.type === 'drop') out = [];
    if (a.type === 'tamper' && a.sensor) {
      out = out.map((m) => {
        const obj = JSON.parse(m) as Telemetry;
        const r = obj.sensors[a.sensor!];
        if (r && r.v !== null) r.v = r3(r.v + (a.delta ?? 1));
        return JSON.stringify(obj); // sig field kept as-is -> no longer matches
      });
    }
    if (a.type === 'replay') {
      const recS = a.recordS ?? 15;
      if (now - a.startedAt < recS * 1000) {
        (a.recordedRaw ??= []).push(raw);
      } else if (a.recordedRaw?.length) {
        out = [a.recordedRaw[(a.playIdx = ((a.playIdx ?? -1) + 1) % a.recordedRaw.length)]!];
      }
    }
  }
  return out;
}
