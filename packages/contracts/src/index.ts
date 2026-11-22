/**
 * @twin/contracts - public entry point (browser-safe).
 * Signing helpers live in '@twin/contracts/signing' because they need Node's crypto.
 */
export * from './devices';
export * from './topics';
export * from './schemas';
export * from './validate';

/** Random lowercase hex string of `bytes` bytes (Web Crypto: works in Node 20+ and browsers). */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 64-bit nonce as 16 hex characters. */
export const newNonce = (): string => randomHex(8);
/** 32-bit boot id as 8 hex characters. */
export const newBootId = (): string => randomHex(4);
/** Command id: time-ordered and unique enough for our scale. */
export const newCmdId = (): string => `${Date.now().toString(36)}-${randomHex(6)}`;
