/**
 * Twin detection tests: the emulator's physics (VirtualRig) is run in virtual
 * time and its telemetry fed to TwinCore. Each scenario checks what the twin
 * concludes, exactly as it would happen live.
 */
import { describe, expect, it } from 'vitest';
import { VirtualRig } from '@twin/emulator/virtual';
import { TwinCore, type Intent, type TwinState } from '../src/twin/core';
import { Cusum } from '../src/twin/cusum';
import { riseTime, classify } from '../src/twin/classifier';
import { diagnose } from '../src/twin/diagnosis';

type Raise = Extract<Intent, { op: 'raise' }>;

function harness() {
  const rig = new VirtualRig();
  const core = new TwinCore();
  const raised: Array<Raise & { ts: number }> = [];
  const resolved: string[] = [];
  let last: TwinState | null = null;
  const run = (seconds: number) => {
    for (const t of rig.run(seconds)) {
      core.ingest(t);
      const out = core.step();
      if (!out) continue;
      last = out.state;
      for (const i of out.intents) {
        if (i.op === 'raise' && i.key !== 'model') raised.push({ ...i, ts: out.state.ts });
        if (i.op === 'resolve') resolved.push(i.key);
      }
    }
  };
  run(75); // learning (60 s) + settle
  expect(core.params).not.toBeNull();
  raised.length = 0;
  return { rig, core, raised, resolved, run, state: () => last! };
}

const lastOf = (raised: Raise[], key: string) => [...raised].reverse().find((r) => r.key === key);

describe('twin detection (virtual rig)', () => {
  it('normal operation with valve changes and pump restart: no alarm', () => {
    const h = harness();
    h.run(120);
    h.rig.plant.outletOpening = 0.6;
    h.run(60);
    h.rig.plant.outletOpening = 1;
    h.run(60);
    h.rig.plant.pumpOn = false;
    h.run(20);
    h.rig.plant.pumpOn = true;
    h.run(60);
    expect(h.raised).toEqual([]);
  });

  it('leak in segment A: detected fast, located, classified as leak', () => {
    const h = harness();
    const t0 = h.rig.now;
    h.rig.leak('A', 0.5); // at 1.0 m
    h.run(30);
    const first = h.raised.find((r) => r.key === 'loss')!;
    expect(first).toBeDefined();
    expect(first.ts - t0).toBeLessThan(5000);
    const a = lastOf(h.raised, 'loss')!;
    expect(a.alert.type).toBe('leak');
    expect(a.alert.segment).toBe('A');
    expect(Math.abs((a.alert.data as { positionM: number }).positionM - 1.0)).toBeLessThan(0.4);
    expect(h.raised.some((r) => r.key === 'integrity')).toBe(false);
  });

  it('leak in segment B is located in B and resolves after repair', () => {
    const h = harness();
    const id = h.rig.leak('B', 0.5); // at 3.0 m
    h.run(30);
    const a = lastOf(h.raised, 'loss')!;
    expect(a.alert.segment).toBe('B');
    expect(Math.abs((a.alert.data as { positionM: number }).positionM - 3.0)).toBeLessThan(0.4);
    h.rig.stopLeak(id);
    h.run(30);
    expect(h.resolved).toContain('loss');
  });

  it('small leak (~4 % of flow) is detected', () => {
    const h = harness();
    h.rig.leak('B', 0.15, { fraction: 0.3 });
    h.run(60);
    expect(h.raised.some((r) => r.key === 'loss')).toBe(true);
  });

  it('theft (valve opened slowly) is classified as theft', () => {
    const h = harness();
    h.rig.leak('B', 0.9, { fraction: 0.6, rampS: 10, kind: 'theft' });
    h.run(45);
    const a = lastOf(h.raised, 'loss')!;
    expect(a.alert.type).toBe('theft');
    expect(a.alert.segment).toBe('B');
  });

  it('FDI: forged F1 (+0.6 L/min) is NOT reported as a leak but as inconsistent data, F1 suspected', () => {
    const h = harness();
    h.rig.attack({ type: 'fdi_bias', sensor: 'F1', delta: 0.6 });
    h.run(30);
    expect(h.raised.some((r) => r.key === 'loss')).toBe(false);
    const a = lastOf(h.raised, 'integrity')!;
    expect(a.alert.type).toBe('fdi');
    expect((a.alert.data as { suspects: string[] }).suspects).toEqual(['F1']);
  });

  it('FDI: downstream node replays old values to hide a leak -> integrity alarm', () => {
    const h = harness();
    h.rig.attack({ type: 'fdi_replay', device: 'node-downstream', recordS: 15 });
    h.run(20);
    expect(h.raised).toEqual([]);
    h.rig.leak('B', 0.6);
    h.run(40);
    const a = lastOf(h.raised, 'integrity')!;
    expect(a).toBeDefined();
    expect((a.alert.data as { suspects: string[] }).suspects).toContain('P2');
  });

  it('stuck P2 is isolated when the operating point changes', () => {
    const h = harness();
    h.rig.fault('P2', 'stuck');
    h.run(10);
    h.rig.plant.outletOpening = 0.6;
    h.run(40);
    expect((lastOf(h.raised, 'integrity')!.alert.data as { suspects: string[] }).suspects).toEqual(['P2']);
  });

  it('drifting P1 is isolated', () => {
    const h = harness();
    h.rig.fault('P1', 'drift', 0.5);
    h.run(90);
    expect((lastOf(h.raised, 'integrity')!.alert.data as { suspects: string[] }).suspects).toEqual(['P1']);
  });
});

describe('building blocks', () => {
  it('CUSUM accumulates small persistent shifts but not noise', () => {
    const c = new Cusum(0.5, 12);
    for (let i = 0; i < 200; i++) expect(c.update(Math.sin(i) * 0.4).alarmPos).toBe(false);
    let n = 0;
    while (!c.update(1.5).alarmPos) n++;
    expect(n).toBeLessThan(15);
  });
  it('rise time and classification', () => {
    const step = [0, 0, 0, 0.5, 1, 1, 1].map((loss, i) => ({ ts: i * 500, loss }));
    expect(riseTime(step, 0, 1)).toBeLessThanOrEqual(1.5);
    expect(classify(1, 1, [], 0).kind).toBe('leak');
    expect(classify(8, 1, [], 0).kind).toBe('theft');
    expect(classify(1, 1, [{ resolvedAt: 0, positionM: 1.2 }], 60_000).kind).toBe('theft');
  });
  it('diagnosis: loss with consistent physics', () => {
    const z = { mass: 20, pump: 0.3, outlet: -0.5, segA: -5, segB: 0, total: -4 };
    expect(diagnose(z, true, false, { fA: 0.5, fB: 0 }).hypothesis).toBe('loss');
  });
});
