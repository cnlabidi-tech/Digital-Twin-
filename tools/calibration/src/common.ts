/**
 * Shared helpers: read-only MQTT connection (monitor account), telemetry
 * capture, platform API login, pressure conversion with a given divider.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mqtt, { type MqttClient } from 'mqtt';
import { parseJson, parseTopic, TOPIC_ROOT, validateTelemetry, type DeviceId, type Telemetry } from '@twin/contracts';

export const SECRETS = process.env.SECRETS_DIR ?? resolve(import.meta.dirname, '../../../secrets');
export const secure = existsSync(resolve(SECRETS, 'ca.crt')) && process.env.SECURITY_MODE !== 'dev';
export const API = process.env.API_URL ?? 'http://localhost:4000';
const readJson = <T>(f: string): T | undefined => (existsSync(resolve(SECRETS, f)) ? (JSON.parse(readFileSync(resolve(SECRETS, f), 'utf8')) as T) : undefined);
export const deviceKeys = () => readJson<Partial<Record<DeviceId, string>>>('device-keys.json') ?? {};

export function connectMonitor(host = process.env.MQTT_HOST ?? 'localhost'): Promise<MqttClient> {
  const creds = readJson<Record<string, string>>('mqtt-credentials.json');
  const url = secure ? `mqtts://${host}:8883` : `mqtt://${host}:1883`;
  return new Promise((res, rej) => {
    const c = mqtt.connect(url, {
      // a distinct client id is impossible in secure mode (id = username): use the monitor account
      clientId: secure ? 'monitor' : `calib-${process.pid}`,
      username: secure ? 'monitor' : undefined,
      password: secure ? creds?.monitor : undefined,
      ca: secure ? readFileSync(resolve(SECRETS, 'ca.crt')) : undefined,
      reconnectPeriod: 0,
      connectTimeout: 5000,
    });
    c.once('connect', () => res(c));
    c.once('error', rej);
  });
}

export interface Captured {
  t: Telemetry;
  raw: string;
  receivedAt: number;
}

/** Collect telemetry (and status messages) for `seconds`. */
export async function capture(c: MqttClient, seconds: number, onTick?: (n: number) => void) {
  const telemetry: Captured[] = [];
  const status: Array<{ deviceId: DeviceId; payload: unknown }> = [];
  const invalid: string[] = [];
  const handler = (topic: string, payload: Buffer) => {
    const p = parseTopic(topic);
    if (!p) return;
    const raw = payload.toString();
    const j = parseJson(raw);
    if (!j.ok) return void invalid.push(`${topic}: invalid JSON`);
    if (p.channel === 'status') status.push({ deviceId: p.deviceId, payload: j.value });
    if (p.channel === 'telemetry') {
      const v = validateTelemetry(j.value);
      if (!v.ok) invalid.push(`${topic}: ${v.errors[0]}`);
      else telemetry.push({ t: v.value, raw, receivedAt: Date.now() });
    }
  };
  c.on('message', handler);
  await c.subscribeAsync(`${TOPIC_ROOT}/#`);
  for (let s = 0; s < seconds; s++) {
    await new Promise((r) => setTimeout(r, 1000));
    onTick?.(telemetry.length);
  }
  c.removeListener('message', handler);
  return { telemetry, status, invalid };
}

export async function login(username = process.env.TWIN_USER ?? 'admin', password = process.env.TWIN_PASSWORD): Promise<string | null> {
  const pw = password ?? readJson<Record<string, string>>('initial-users.json')?.[username];
  if (!pw) return null;
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: pw }) });
  if (!r.ok) return null;
  return ((await r.json()) as { token: string }).token;
}

/** ADS1115 counts -> bar for a given divider ratio (no calibration applied). */
export function countsToBarRaw(counts: number, divider: number): number {
  const v = (counts * 4.096) / 32768 / divider;
  return ((v - 1) / 4) * 10;
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
export const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(xs.length - 1, 1));
};
