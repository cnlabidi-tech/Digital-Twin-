/**
 * Shared environment helper for the emulator and monitor: loads
 * secrets/emulator.env when present and resolves secret file paths
 * (container paths fall back to ./secrets/<file name> when run locally).
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const SECRETS = process.env.SECRETS_DIR ?? resolve(import.meta.dirname, '../../../secrets');
const envFile = resolve(SECRETS, 'emulator.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const secure = (process.env.SECURITY_MODE ?? (existsSync(resolve(SECRETS, 'ca.crt')) ? 'secure' : 'dev')) === 'secure';

export function secretFile(p: string | undefined, name: string): string | undefined {
  if (p && existsSync(p)) return p;
  const local = resolve(SECRETS, p ? basename(p) : name);
  return existsSync(local) ? local : undefined;
}

export function brokerUrl(): string {
  const host = process.env.MQTT_HOST ?? 'localhost';
  return process.env.MQTT_URL ?? (secure ? `mqtts://${host}:8883` : `mqtt://${host}:1883`);
}

export function caCert(): Buffer | undefined {
  const f = secure ? secretFile(process.env.MQTT_CA_FILE, 'ca.crt') : undefined;
  return f ? readFileSync(f) : undefined;
}

export function readJsonSecret<T>(envPath: string | undefined, name: string): T | undefined {
  const f = secretFile(envPath, name);
  return f ? (JSON.parse(readFileSync(f, 'utf8')) as T) : undefined;
}
