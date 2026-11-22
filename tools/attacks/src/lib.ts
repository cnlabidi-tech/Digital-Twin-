/**
 * Shared helpers for the attack demonstrations.
 *
 * SCOPE: these scripts attack OUR OWN lab platform (localhost) to prove that
 * each defence works. They read the lab secrets in ./secrets to play the roles
 * of different attackers (outsider, stolen device account, compromised
 * privileged account, compromised device).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

export const SECRETS = process.env.SECRETS_DIR ?? resolve(import.meta.dirname, '../../../secrets');
export const BROKER = process.env.BROKER_HOST ?? 'localhost';
export const API = process.env.API_URL ?? 'http://localhost:4000';
export const EMU = process.env.EMU_URL ?? 'http://localhost:4100';

export function secret<T = Record<string, string>>(name: string): T {
  const f = resolve(SECRETS, name);
  if (!existsSync(f)) throw new Error(`missing ${f} - run: npm run setup -w @twin/security`);
  return JSON.parse(readFileSync(f, 'utf8')) as T;
}
export const ca = () => readFileSync(resolve(SECRETS, 'ca.crt'));
export const creds = () => secret('mqtt-credentials.json');
export const deviceKeys = () => secret('device-keys.json');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect; resolves with the client, or rejects with the connection error. */
export function connect(url: string, opts: IClientOptions, timeoutMs = 5000): Promise<MqttClient> {
  return new Promise((resolveP, reject) => {
    const c = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: timeoutMs, ...opts });
    const t = setTimeout(() => {
      c.end(true);
      reject(new Error('timeout'));
    }, timeoutMs + 500);
    c.once('connect', () => {
      clearTimeout(t);
      resolveP(c);
    });
    c.once('error', (e) => {
      clearTimeout(t);
      c.end(true);
      reject(e);
    });
    c.once('close', () => {
      clearTimeout(t);
      reject(new Error('connection closed by broker'));
    });
  });
}

/** Connect over TLS as one of the lab accounts. */
export function as(user: string, extra: IClientOptions = {}): Promise<MqttClient> {
  return connect(`mqtts://${BROKER}:8883`, { username: user, password: creds()[user], ca: ca(), clientId: user, ...extra });
}

// ------------------------------------------------------------- reporting
export interface Result {
  attack: string;
  defence: string;
  held: boolean;
  evidence: string;
}
const results: Result[] = [];
export function report(attack: string, defence: string, held: boolean, evidence: string): void {
  results.push({ attack, defence, held, evidence });
  const tag = held ? '\x1b[32mDEFENCE HELD\x1b[0m' : '\x1b[31mDEFENCE FAILED\x1b[0m';
  console.log(`  ${tag}  ${attack}\n               defence: ${defence}\n               evidence: ${evidence}`);
}
export const allResults = () => results;

export function title(t: string): void {
  console.log(`\n=== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);
}

// ------------------------------------------------------------- platform API
export async function adminToken(): Promise<string> {
  const users = secret('initial-users.json');
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: users.admin }),
  });
  if (!r.ok) throw new Error(`admin login failed (${r.status}) - was the admin password changed?`);
  return ((await r.json()) as { token: string }).token;
}

export async function apiGet<T>(path: string, token: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()) as T;
}

/** Rejected-message counters of the backend security gate. */
export async function rejectedCounts(token: string): Promise<Record<string, number>> {
  const s = await apiGet<{ rejected: Record<string, number> }>('/api/security/status', token);
  return s.rejected ?? {};
}

export function diff(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) if (v - (before[k] ?? 0) > 0) out[k] = v - (before[k] ?? 0);
  return out;
}

/** Wait for the next message on a topic. */
export function nextMessage(c: MqttClient, topic: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((res) => {
    const t = setTimeout(() => {
      c.removeListener('message', on);
      res(null);
    }, timeoutMs);
    const on = (tp: string, payload: Buffer) => {
      if (tp !== topic) return;
      clearTimeout(t);
      c.removeListener('message', on);
      res(payload.toString());
    };
    c.on('message', on);
    c.subscribe(topic);
  });
}

export async function emuAvailable(): Promise<boolean> {
  try {
    return (await fetch(`${EMU}/api/state`)).ok;
  } catch {
    return false;
  }
}

export async function emu(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const r = await fetch(`${EMU}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

/** Run a script's main() when executed directly. */
export function runIfMain(meta: ImportMeta, main: () => Promise<void>): void {
  if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(meta.url).pathname)) {
    main().then(() => process.exit(0), (e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
