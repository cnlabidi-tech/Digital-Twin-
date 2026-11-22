import { describe, expect, it } from 'vitest';
import { newBootId, newNonce, type Telemetry } from '@twin/contracts';
import { bus, type Rejection } from '../src/bus';
import { handleMessage, stats } from '../src/ingestion/handler';
import { placeholders, telemetryRows } from '../src/ingestion/writer';

const tel = (): Telemetry => ({
  v: 1, deviceId: 'node-inlet', bootId: newBootId(), seq: 3, ts: Date.now(), nonce: newNonce(), intervalMs: 500,
  sensors: { P1: { v: 4.1, raw: 14000, q: 'ok' }, F1: { v: 3.5, raw: 300, q: 'ok' } },
  actuators: { pump: { on: true, duty: 100 } },
  diag: { uptimeS: 5, rssi: -50, heapFree: 1000, ntpSynced: true },
});

function capture() {
  const got: { telemetry: unknown[]; rejected: Rejection[] } = { telemetry: [], rejected: [] };
  bus.on('telemetry', (r) => got.telemetry.push(r));
  bus.on('rejected', (r) => got.rejected.push(r));
  return got;
}

describe('ingestion handler', () => {
  const got = capture();
  it('accepts valid telemetry', () => {
    handleMessage('pipeline/v1/node-inlet/telemetry', Buffer.from(JSON.stringify(tel())));
    expect(got.telemetry).toHaveLength(1);
  });
  it('rejects topic/payload device mismatch', () => {
    handleMessage('pipeline/v1/node-downstream/telemetry', Buffer.from(JSON.stringify(tel())));
    expect(got.rejected.at(-1)!.reason).toBe('device_mismatch');
  });
  it('rejects invalid json, unknown topics, schema errors and oversize payloads', () => {
    handleMessage('pipeline/v1/node-inlet/telemetry', Buffer.from('{oops'));
    expect(got.rejected.at(-1)!.reason).toBe('invalid_json');
    handleMessage('pipeline/v1/evil/telemetry', Buffer.from('{}'));
    expect(got.rejected.at(-1)!.reason).toBe('unknown_topic');
    handleMessage('pipeline/v1/node-inlet/telemetry', Buffer.from(JSON.stringify({ ...tel(), seq: -1 })));
    expect(got.rejected.at(-1)!.reason).toBe('schema');
    handleMessage('pipeline/v1/node-inlet/telemetry', Buffer.alloc(9000, 32));
    expect(got.rejected.at(-1)!.reason).toBe('too_large');
    expect(stats.rejected.schema).toBeGreaterThan(0);
  });
  it('ignores our own commands', () => {
    const before = stats.received;
    handleMessage('pipeline/v1/node-inlet/cmd', Buffer.from('{}'));
    expect(stats.received).toBe(before);
  });
});

describe('storage mapping', () => {
  it('maps one message to 1 envelope row + 1 row per sensor', () => {
    const r = telemetryRows({ msg: tel(), receivedAt: Date.now(), raw: '', signed: false });
    expect(r.message).toHaveLength(14);
    expect(r.readings).toHaveLength(2);
  });
  it('builds numbered placeholders', () => {
    expect(placeholders([[1, 2], [3, 4]])).toEqual({ sql: '($1,$2),($3,$4)', params: [1, 2, 3, 4] });
  });
});
