import { describe, expect, it } from 'vitest';
import { newBootId, newNonce, type Telemetry } from '@twin/contracts';
import { signMessage } from '@twin/contracts/signing';
import { createSecurityGate } from '../src/security/gate';
import { PlausibilityChecker } from '../src/security/plausibility';
import { hashPassword, verifyPassword } from '../src/security/auth';

const KEY = 'ab'.repeat(32);
const tel = (seq: number, over: Partial<Telemetry> = {}): Telemetry => ({
  v: 1, deviceId: 'node-inlet', bootId: 'aaaaaaaa', seq, ts: Date.now(), nonce: newNonce(), intervalMs: 500,
  sensors: { P1: { v: 4.1, raw: 14000, q: 'ok' }, F1: { v: 3.5, raw: 300 + seq * 13, q: 'ok' } },
  actuators: { pump: { on: true, duty: 100 } }, diag: { uptimeS: 1, rssi: -50, heapFree: 1, ntpSynced: true }, ...over,
});

describe('security gate', () => {
  const mk = () => createSecurityGate({ keys: { 'node-inlet': KEY }, requireSignatures: true, maxClockSkewMs: 30_000, maxRatePerDevice: 20 }).gate;
  const run = (g: ReturnType<typeof mk>, t: Telemetry, raw = signMessage(t, KEY), at = Date.now()) => g('telemetry', JSON.parse(raw), raw, at);

  it('accepts a correctly signed fresh message', () => expect(run(mk(), tel(1)).ok).toBe(true));
  it('rejects unsigned, tampered and wrong-key messages', () => {
    const g = mk();
    const t = tel(1);
    expect(run(g, t, JSON.stringify(t))).toMatchObject({ ok: false, reason: 'missing_signature' });
    expect(run(g, t, signMessage(t, KEY).replace('"v":4.1', '"v":9.1'))).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(run(g, t, signMessage(t, 'cd'.repeat(32)))).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
  it('rejects exact replays, stale messages and old sequence numbers', () => {
    const g = mk();
    const t = tel(5);
    const raw = signMessage(t, KEY);
    expect(run(g, t, raw).ok).toBe(true);
    expect(run(g, t, raw)).toMatchObject({ ok: false, reason: 'replayed_nonce' });
    expect(run(g, tel(6, { ts: Date.now() - 60_000 }))).toMatchObject({ ok: false, reason: 'stale_timestamp' });
    expect(run(g, tel(3))).toMatchObject({ ok: false, reason: 'sequence_replay' });
    expect(run(g, tel(1, { bootId: newBootId() })).ok).toBe(true); // reboot: new boot id restarts seq
  });
  it('rate-limits authentic floods only', () => {
    const g = mk();
    const now = Date.now();
    let limited = 0;
    for (let i = 0; i < 40; i++) if (!run(g, tel(100 + i), undefined, now).ok) limited++;
    expect(limited).toBe(20);
  });
});

describe('plausibility checks', () => {
  it('flags a frozen pressure and a value that contradicts its raw reading', () => {
    const c = new PlausibilityChecker();
    const t0 = Date.now();
    let found: string[] = [];
    for (let i = 0; i < 60; i++) {
      // 30 s of identical P1 while the pump runs
      found = c.check(tel(i, { ts: t0 + i * 500 })).map((f) => f.check);
    }
    expect(found).toContain('frozen');
    const forged = tel(61, { ts: t0 + 61 * 500 });
    forged.sensors.P1 = { v: 6.5, raw: 14000, q: 'ok' };
    expect(c.check(forged).map((f) => f.check)).toContain('raw_mismatch');
  });
});

describe('passwords', () => {
  it('scrypt hash verifies only the right password', () => {
    const h = hashPassword('correct horse');
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
});
