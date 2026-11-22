/**
 * Message handler: the single entry point for everything that arrives from
 * the field. Pipeline (each step can reject the message):
 *
 *   topic  -> must belong to the contract (known device + channel)
 *   size   -> at most 8 KB
 *   JSON   -> must parse
 *   device -> deviceId in the payload must match the topic
 *   schema -> structural + semantic validation (packages/contracts)
 *   [Phase 6: signature, freshness, nonce, sequence - see security/]
 *   -> publish on the internal bus (storage, twin, dashboard)
 *
 * Commands are published by the platform itself; the handler ignores them.
 */
import { parseJson, parseTopic, validateAck, validateStatus, validateTelemetry, type Channel } from '@twin/contracts';
import { bus } from '../bus';

export interface IngestStats {
  received: number;
  accepted: number;
  rejected: Record<string, number>;
}
export const stats: IngestStats = { received: 0, accepted: 0, rejected: {} };

/** Optional extra check (installed by the security module in Phase 6). */
export type SecurityGate = (channel: Channel, msg: unknown, raw: string, receivedAt: number) => { ok: true } | { ok: false; reason: string; details?: unknown };
let gate: SecurityGate | undefined;
export const setSecurityGate = (g: SecurityGate | undefined) => (gate = g);

function reject(topic: string, reason: string, details?: unknown, deviceId?: string, channel?: string, raw?: string) {
  stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
  bus.emit('rejected', { time: Date.now(), topic, reason, details, deviceId, channel, raw });
}

export function handleMessage(topic: string, payload: Buffer, receivedAt = Date.now()): void {
  const t = parseTopic(topic);
  if (!t) return reject(topic, 'unknown_topic');
  if (t.channel === 'cmd') return; // our own commands echoed by the broker
  stats.received++;
  if (payload.length > 8192) return reject(topic, 'too_large', { bytes: payload.length }, t.deviceId, t.channel);

  const raw = payload.toString('utf8');
  const json = parseJson(raw);
  if (!json.ok) return reject(topic, 'invalid_json', json.errors, t.deviceId, t.channel, raw);

  // The device id inside the payload must match the topic (topic spoofing).
  const inner = (json.value as { deviceId?: unknown } | null)?.deviceId;
  if (inner !== t.deviceId) {
    return reject(topic, 'device_mismatch', { topic: t.deviceId, payload: inner }, t.deviceId, t.channel, raw);
  }

  const validator = { telemetry: validateTelemetry, status: validateStatus, ack: validateAck }[t.channel];
  const v = validator(json.value);
  if (!v.ok) return reject(topic, 'schema', v.errors, t.deviceId, t.channel, raw);

  if (gate) {
    const g = gate(t.channel, v.value, raw, receivedAt);
    if (!g.ok) return reject(topic, g.reason, g.details, t.deviceId, t.channel, raw);
  }

  stats.accepted++;
  const signed = raw.includes('"sig":"');
  // The validator matched the channel, so the casts below are safe.
  if (t.channel === 'telemetry') bus.emit('telemetry', { msg: v.value as never, receivedAt, raw, signed });
  else if (t.channel === 'status') bus.emit('status', { msg: v.value as never, receivedAt, raw, signed });
  else bus.emit('ack', { msg: v.value as never, receivedAt, raw, signed });
}
