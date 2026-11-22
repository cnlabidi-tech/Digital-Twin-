import { describe, expect, it } from 'vitest';
import { newBootId, newNonce, validateTelemetry, type Telemetry } from '@twin/contracts';
import { signMessage, verifyMessage } from '@twin/contracts/signing';
import { applyFdi, applyNetwork, createAttack } from '../src/attacks';
import { countsToReading, pulsesToReading } from '../src/firmware-logic';
import { coeffFromRate, solve } from '../src/hydraulics';
import { barToCounts, Plant } from '../src/plant';

const probes = { P1: 0, F1: 0.15, P2: 2, P3: 4, F2: 4.15 };

describe('hydraulics', () => {
  it('nominal point is plausible and mass is conserved', () => {
    const r = solve(1, 1, [], probes);
    expect(r.q1).toBeGreaterThan(3);
    expect(r.q1).toBeLessThan(4);
    expect(r.qOut).toBeCloseTo(r.q1, 6);
    expect(r.pressureAt.P1!).toBeGreaterThan(r.pressureAt.P2!);
    expect(r.pressureAt.P2!).toBeGreaterThan(r.pressureAt.P3!);
  });
  it('a leak creates a flow imbalance equal to the leak flow', () => {
    const r = solve(1, 1, [{ id: 'l', kind: 'leak', positionM: 1, coeff: coeffFromRate(0.5), opening: 1 }], probes);
    expect(r.q1 - r.qOut).toBeCloseTo(r.tapFlows.l!, 6);
    expect(r.tapFlows.l!).toBeGreaterThan(0.4);
  });
  it('closing the outlet valve raises pressure and lowers flow without imbalance', () => {
    const open = solve(1, 1, [], probes);
    const half = solve(1, 0.5, [], probes);
    expect(half.q1).toBeLessThan(open.q1);
    expect(half.pressureAt.P3!).toBeGreaterThan(open.pressureAt.P3!);
    expect(half.q1 - half.qOut).toBeCloseTo(0, 6);
  });
  it('pump off => no flow, no pressure', () => {
    const r = solve(0, 1, [], probes);
    expect(r.q1).toBe(0);
    expect(r.pressureAt.P1).toBe(0);
  });
});

describe('firmware conversions', () => {
  it('pressure counts round-trip', () => {
    for (const bar of [0, 2.5, 5, 9.9]) expect(countsToReading(barToCounts(bar)).v!).toBeCloseTo(bar, 2);
  });
  it('disconnected transducer (0 V) is out_of_range', () => {
    expect(countsToReading(0)).toMatchObject({ v: null, q: 'out_of_range' });
  });
  it('pulses -> flow', () => {
    expect(pulsesToReading(1000 + 15, 1000, 0.5).v).toBeCloseTo(4, 3); // 30 Hz / 7.5
  });
});

describe('plant dynamics', () => {
  it('settles to steady state', () => {
    const p = new Plant();
    for (let i = 0; i < 200; i++) p.step(0.05);
    expect(p.truth().flow.F1).toBeCloseTo(solve(1, 1, [], probes).flowAt.F1!, 1);
  });
});

const tel = (): Telemetry => ({
  v: 1, deviceId: 'node-downstream', bootId: newBootId(), seq: 1, ts: Date.now(), nonce: newNonce(), intervalMs: 500,
  sensors: { P2: { v: 3.6, raw: barToCounts(3.6), q: 'ok' }, P3: { v: 3.1, raw: barToCounts(3.1), q: 'ok' }, F2: { v: 3.4, raw: 500, q: 'ok' } },
  diag: { uptimeS: 1, rssi: -50, heapFree: 1, ntpSynced: true },
});

describe('attacks', () => {
  it('fdi_bias changes value and keeps raw consistent; message stays valid', () => {
    const t = tel();
    applyFdi(t, [createAttack('a', { type: 'fdi_bias', sensor: 'P2', delta: 1 }, Date.now())], Date.now());
    expect(t.sensors.P2!.v).toBeCloseTo(4.6, 3);
    expect(countsToReading(t.sensors.P2!.raw).v!).toBeCloseTo(4.6, 2);
    expect(validateTelemetry(t).ok).toBe(true);
  });
  it('fdi_replay records then replays', () => {
    const start = Date.now();
    const a = createAttack('a', { type: 'fdi_replay', device: 'node-downstream', recordS: 1 }, start);
    const t1 = tel(); applyFdi(t1, [a], start + 100); // recorded: P2=3.6
    const t2 = tel(); t2.sensors.P2!.v = 1.0; applyFdi(t2, [a], start + 2000);
    expect(t2.sensors.P2!.v).toBeCloseTo(3.6, 3);
  });
  it('tamper breaks the signature', () => {
    const key = 'ab'.repeat(32);
    const raw = signMessage(tel(), key);
    const [out] = applyNetwork('node-downstream', raw, [createAttack('a', { type: 'tamper', sensor: 'F2', delta: 1 }, 0)], 0);
    expect(verifyMessage(out!, key).ok).toBe(false);
  });
  it('drop suppresses messages', () => {
    expect(applyNetwork('node-downstream', '{}', [createAttack('a', { type: 'drop', device: 'node-downstream' }, 0)], 0)).toEqual([]);
  });
});
