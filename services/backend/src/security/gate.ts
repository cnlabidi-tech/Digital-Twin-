/**
 * Message security gate - runs on every device message after schema
 * validation, before anything reaches the twin or the database.
 *
 *   1. Signature   HMAC-SHA256 with the sending device's key (integrity +
 *                  authenticity: only the holder of that key can produce it).
 *   2. Freshness   |platform clock - message ts| <= 30 s (stale = replay or bad clock).
 *   3. Nonce       never seen before within the freshness window (exact replay).
 *   4. Sequence    strictly increasing per (device, boot id) (re-ordering / replay
 *                  of messages from the same boot even inside the window).
 *   5. Rate        at most N authentic messages / second / device (a compromised
 *                  device flooding). Checked after the signature: forged floods are
 *                  dropped by step 1 and never starve the genuine device.
 *
 * The broker already stops outsiders (TLS + credentials + ACL); this layer
 * still protects the twin if a broker account is stolen or the broker itself
 * is compromised (defence in depth).
 */
import type { Channel, DeviceId, Status } from '@twin/contracts';
import { verifyMessage } from '@twin/contracts/signing';
import type { SecurityGate } from '../ingestion/handler';

export interface GateOptions {
  keys: Partial<Record<DeviceId, string>>;
  requireSignatures: boolean;
  maxClockSkewMs: number;
  maxRatePerDevice: number;
}

export interface GateStats {
  checked: number;
  rejected: Record<string, number>;
}

export function createSecurityGate(o: GateOptions) {
  const nonces = new Map<string, number>(); // `${device}:${nonce}` -> expiry
  const lastSeq = new Map<string, { bootId: string; seq: number }>(); // device -> last
  const rate = new Map<string, { windowStart: number; count: number }>();
  const stats: GateStats = { checked: 0, rejected: {} };
  let lastPurge = 0;

  const fail = (reason: string, details?: unknown) => {
    stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
    return { ok: false as const, reason, details };
  };

  const gate: SecurityGate = (channel: Channel, msg: unknown, raw: string, receivedAt: number) => {
    stats.checked++;
    const m = msg as { deviceId: DeviceId; ts?: number; nonce?: string; seq?: number; bootId?: string };
    const dev = m.deviceId;

    // The broker's last-will cannot carry a fresh timestamp or signature.
    // It is accepted only in its exact minimal form (and only the device's own
    // broker account can register it, thanks to the ACL).
    if (channel === 'status') {
      const s = msg as Status;
      if (!s.online && s.reason === 'lwt' && s.ts === undefined && !raw.includes('"sig"')) return { ok: true };
    }

    // 1. signature
    const key = o.keys[dev];
    if (key) {
      const v = verifyMessage(raw, key);
      if (!v.ok && (v.reason === 'bad_signature' || o.requireSignatures)) return fail(v.reason);
    } else if (o.requireSignatures) {
      return fail('no_key_for_device');
    }

    // 5. rate limit - counted only for authentic messages, so forged traffic
    //    can never consume the genuine device's budget (it is dropped above).
    const r = rate.get(dev);
    if (!r || receivedAt - r.windowStart >= 1000) rate.set(dev, { windowStart: receivedAt, count: 1 });
    else if (++r.count > o.maxRatePerDevice) return fail('rate_limited', { perSecond: r.count });

    // 2. freshness
    if (typeof m.ts === 'number' && Math.abs(receivedAt - m.ts) > o.maxClockSkewMs) {
      return fail('stale_timestamp', { skewMs: receivedAt - m.ts });
    }

    // 3. nonce cache
    if (receivedAt - lastPurge > 5000) {
      for (const [k, exp] of nonces) if (exp < receivedAt) nonces.delete(k);
      lastPurge = receivedAt;
    }
    if (m.nonce) {
      const k = `${dev}:${m.nonce}`;
      if (nonces.has(k)) return fail('replayed_nonce');
      nonces.set(k, receivedAt + 2 * o.maxClockSkewMs);
    }

    // 4. sequence (telemetry only)
    if (channel === 'telemetry' && typeof m.seq === 'number' && m.bootId) {
      const last = lastSeq.get(dev);
      if (last && last.bootId === m.bootId && m.seq <= last.seq) return fail('sequence_replay', { last: last.seq, got: m.seq });
      lastSeq.set(dev, { bootId: m.bootId, seq: m.seq });
    }
    return { ok: true };
  };

  return { gate, stats };
}
