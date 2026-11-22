/**
 * Message signing - HMAC-SHA256 with a per-device secret key (Node.js only).
 *
 * WHAT EXACTLY IS SIGNED
 * ----------------------
 * The sender serialises the message as compact JSON WITHOUT the `sig` field,
 * computes  sig = HMAC-SHA256(key, utf8(json))  and then inserts
 * `,"sig":"<64 hex>"` just before the final `}`. So `sig` is always the last
 * field. The receiver strips that exact suffix and recomputes the HMAC over
 * the remaining bytes.
 *
 * Why this scheme: it signs the exact bytes on the wire, so there is no
 * "canonical JSON" problem (key order, number formatting) between C++
 * (ArduinoJson on the ESP32) and JavaScript. It is trivial to implement on
 * the microcontroller: serialise, HMAC, append.
 *
 * Replay protection is NOT provided by the HMAC alone: the receiver must also
 * check `ts` (freshness window) and `nonce` (not seen before) - Phase 6.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_SUFFIX = /,"sig":"([0-9a-f]{64})"\}\s*$/;

export function hmacHex(keyHex: string, data: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data, 'utf8').digest('hex');
}

/** Serialise `msg` (must not contain `sig`) and append its signature. */
export function signMessage(msg: object, keyHex: string): string {
  if ('sig' in msg) throw new Error('message already has a sig field');
  const body = JSON.stringify(msg);
  return `${body.slice(0, -1)},"sig":"${hmacHex(keyHex, body)}"}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'bad_signature' };

/** Verify the signature of a raw message text (as received from MQTT). */
export function verifyMessage(raw: string, keyHex: string): VerifyResult {
  const m = SIG_SUFFIX.exec(raw);
  if (!m || m.index === undefined) return { ok: false, reason: 'missing_signature' };
  const body = `${raw.slice(0, m.index)}}`;
  const expected = Buffer.from(hmacHex(keyHex, body), 'hex');
  const given = Buffer.from(m[1]!, 'hex');
  // Constant-time comparison: avoids leaking how many leading bytes matched.
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
