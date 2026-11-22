import { describe, expect, it } from 'vitest';
import {
  newBootId, newCmdId, newNonce, parseTopic, topicFor,
  validateAck, validateCommand, validateTelemetry, type Telemetry,
} from '../src/index';
import { signMessage, verifyMessage } from '../src/signing';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const inlet = (): Telemetry => ({
  v: 1, deviceId: 'node-inlet', bootId: newBootId(), seq: 1, ts: Date.now(), nonce: newNonce(),
  intervalMs: 500,
  sensors: { P1: { v: 4.1, raw: 18000, q: 'ok' }, F1: { v: 3.5, raw: 1234, q: 'ok' } },
  actuators: { pump: { on: true, duty: 100 } },
  diag: { uptimeS: 10, rssi: -50, heapFree: 200000, ntpSynced: true },
});

describe('topics', () => {
  it('round-trips', () => {
    expect(parseTopic(topicFor('node-inlet', 'telemetry'))).toEqual({ deviceId: 'node-inlet', channel: 'telemetry' });
  });
  it('rejects foreign topics and unknown devices', () => {
    expect(parseTopic('pipeline/v1/evil-node/telemetry')).toBeNull();
    expect(parseTopic('other/v1/node-inlet/telemetry')).toBeNull();
  });
});

describe('telemetry validation', () => {
  it('accepts a valid message', () => expect(validateTelemetry(inlet()).ok).toBe(true));
  it('rejects unknown fields', () => expect(validateTelemetry({ ...inlet(), extra: 1 }).ok).toBe(false));
  it('rejects sensors of another device', () => {
    const t = inlet(); (t.sensors as Record<string, unknown>).P2 = { v: 1, raw: 1, q: 'ok' };
    expect(validateTelemetry(t).ok).toBe(false);
  });
  it('rejects missing pump state on inlet', () => {
    const t = inlet(); delete t.actuators;
    expect(validateTelemetry(t).ok).toBe(false);
  });
  it('rejects absurd value flagged ok', () => {
    const t = inlet(); t.sensors.P1!.v = 50;
    expect(validateTelemetry(t).ok).toBe(false);
  });
});

describe('commands and acks', () => {
  const base = { v: 1, cmdId: newCmdId(), ts: Date.now(), nonce: newNonce(), issuedBy: 'user:test' } as const;
  it('accepts pump.set on inlet', () =>
    expect(validateCommand({ ...base, deviceId: 'node-inlet', type: 'pump.set', params: { on: false } }).ok).toBe(true));
  it('rejects pump.set on downstream', () =>
    expect(validateCommand({ ...base, deviceId: 'node-downstream', type: 'pump.set', params: { on: false } }).ok).toBe(false));
  it('rejects wrong params', () =>
    expect(validateCommand({ ...base, deviceId: 'node-inlet', type: 'ping', params: { x: 1 } }).ok).toBe(false));
  it('accepts an ack', () =>
    expect(validateAck({ v: 1, cmdId: base.cmdId, deviceId: 'node-inlet', ts: Date.now(), nonce: newNonce(), status: 'rejected', reason: 'bad_signature' }).ok).toBe(true));
});

describe('signing', () => {
  it('signed message verifies and still validates', () => {
    const raw = signMessage(inlet(), KEY);
    expect(verifyMessage(raw, KEY).ok).toBe(true);
    expect(validateTelemetry(JSON.parse(raw)).ok).toBe(true);
  });
  it('detects tampering', () => {
    const raw = signMessage(inlet(), KEY).replace('"v":4.1', '"v":9.9');
    expect(verifyMessage(raw, KEY)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('detects wrong key and missing sig', () => {
    const raw = signMessage(inlet(), KEY);
    expect(verifyMessage(raw, KEY.replace('00', 'ff')).ok).toBe(false);
    expect(verifyMessage(JSON.stringify(inlet()), KEY)).toEqual({ ok: false, reason: 'missing_signature' });
  });
});
