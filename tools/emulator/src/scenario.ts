/**
 * Scenario runner: executes a timed list of injections from a JSON file so
 * that every experiment (Phase 9 metrics, defence demo) is reproducible.
 *
 * {
 *   "name": "leak-segment-a",
 *   "durationS": 120,
 *   "steps": [
 *     { "at": 30, "action": "leak", "args": { "segment": "A", "rateLpm": 0.5 }, "as": "L1" },
 *     { "at": 90, "action": "stop", "ref": "L1" }
 *   ]
 * }
 * Actions: leak, theft, valve, pump, fault, attack, offline, stop, reset.
 */
import { readFileSync } from 'node:fs';
import type { DeviceId, SensorId } from '@twin/contracts';
import type { AttackSpec } from './attacks';
import type { Emulator, TapRequest } from './emulator';
import type { FaultType } from './plant';

export interface ScenarioStep {
  at: number;
  action: 'leak' | 'theft' | 'valve' | 'pump' | 'fault' | 'attack' | 'offline' | 'stop' | 'reset';
  args?: Record<string, unknown>;
  /** Name to refer to the created injection in a later "stop". */
  as?: string;
  ref?: string;
}
export interface Scenario {
  name: string;
  description?: string;
  durationS?: number;
  steps: ScenarioStep[];
}

export function loadScenario(path: string): Scenario {
  const s = JSON.parse(readFileSync(path, 'utf8')) as Scenario;
  if (!s.name || !Array.isArray(s.steps)) throw new Error(`${path}: needs "name" and "steps"`);
  return s;
}

export function runScenario(emu: Emulator, sc: Scenario, onDone?: () => void): void {
  const refs = new Map<string, { kind: 'tap' | 'fault' | 'attack'; id: string }>();
  console.log(`[scenario] ${sc.name}: ${sc.steps.length} steps${sc.durationS ? `, ${sc.durationS}s` : ''}`);
  emu.truth('scenario_start', { name: sc.name });

  const exec = (st: ScenarioStep) => {
    const a = st.args ?? {};
    console.log(`[scenario] t=${st.at}s ${st.action} ${JSON.stringify(a)}${st.ref ? ` ref=${st.ref}` : ''}`);
    try {
      switch (st.action) {
        case 'leak':
        case 'theft': {
          const tap = emu.addTap({ ...(a as Partial<TapRequest>), kind: st.action });
          if (st.as) refs.set(st.as, { kind: 'tap', id: tap.id });
          break;
        }
        case 'valve':
          emu.setValve(Number(a.outletOpening));
          break;
        case 'pump':
          emu.setPump(Boolean(a.on), a.duty === undefined ? undefined : Number(a.duty));
          break;
        case 'fault': {
          const id = emu.addFault(a.sensor as SensorId, a.type as FaultType, a.magnitude as number | undefined);
          if (st.as) refs.set(st.as, { kind: 'fault', id });
          break;
        }
        case 'attack': {
          const atk = emu.addAttack(a as unknown as AttackSpec);
          if (st.as) refs.set(st.as, { kind: 'attack', id: atk.id });
          break;
        }
        case 'offline':
          emu.deviceOffline(a.device as DeviceId, Number(a.seconds ?? 20));
          break;
        case 'stop': {
          const r = st.ref ? refs.get(st.ref) : undefined;
          if (!r) throw new Error(`unknown ref ${st.ref}`);
          if (r.kind === 'tap') emu.removeTap(r.id);
          if (r.kind === 'fault') emu.removeFault(r.id);
          if (r.kind === 'attack') emu.removeAttack(r.id);
          break;
        }
        case 'reset':
          emu.reset();
          break;
        default:
          throw new Error(`unknown action ${(st as ScenarioStep).action}`);
      }
    } catch (e) {
      console.error(`[scenario] step failed: ${(e as Error).message}`);
    }
  };

  for (const st of sc.steps) setTimeout(() => exec(st), st.at * 1000);
  if (sc.durationS) {
    setTimeout(() => {
      emu.truth('scenario_end', { name: sc.name });
      console.log(`[scenario] ${sc.name} finished`);
      onDone?.();
    }, sc.durationS * 1000);
  }
}
