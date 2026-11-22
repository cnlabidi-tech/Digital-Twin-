/** Small client for the platform API and the emulator API (live evaluation and demo). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const API = process.env.API_URL ?? 'http://localhost:4000';
export const EMU = process.env.EMU_URL ?? 'http://localhost:4100';
const SECRETS = process.env.SECRETS_DIR ?? resolve(import.meta.dirname, '../../../secrets');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Alert { id: number; key: string; type: string; segment: string | null; message: string; data: Record<string, unknown> | null; created_at: string; state: string }
export interface Cmd { cmd_id: string; issued_by: string; type: string; params: Record<string, unknown>; status: string; verified: boolean; created_at: string; acked_at: string | null }

export class Platform {
  private token = '';

  async login(user = process.env.TWIN_USER ?? 'admin', password = process.env.TWIN_PASSWORD): Promise<void> {
    const f = resolve(SECRETS, 'initial-users.json');
    const pw = password ?? (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>)[user] : undefined);
    const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw ?? '' }) });
    if (r.ok) this.token = ((await r.json()) as { token: string }).token;
    else if (r.status !== 404) {
      // dev mode (no login) answers /api/auth/me with a dev admin
      const me = await fetch(`${API}/api/auth/me`);
      if (!me.ok) throw new Error(`login failed (${r.status}): set TWIN_USER / TWIN_PASSWORD`);
    }
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${API}${path}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return (await r.json()) as T;
  }

  async post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}`);
    return j;
  }

  alerts = () => this.get<Alert[]>('/api/alerts');
  commands = (n = 20) => this.get<Cmd[]>(`/api/commands?limit=${n}`);
  twin = () => this.get<{ state: { mode: string; measured: { pumpOn: boolean } | null } | null }>('/api/twin');

  async pump(on: boolean, force = false): Promise<void> {
    await this.post('/api/commands', { deviceId: 'node-inlet', type: 'pump.set', params: on ? { on: true, duty: 100 } : { on: false }, force });
  }

  /** Wait until an alert matching `pred` exists; returns it and the elapsed seconds since `t0`. */
  async waitAlert(pred: (a: Alert) => boolean, t0: number, timeoutS: number): Promise<{ alert: Alert; delayS: number } | null> {
    while (Date.now() - t0 < timeoutS * 1000) {
      const a = (await this.alerts()).find(pred);
      if (a) return { alert: a, delayS: (Date.now() - t0) / 1000 };
      await sleep(250);
    }
    return null;
  }

  async waitMonitoring(timeoutS = 120): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutS * 1000) {
      const t = await this.twin();
      if (t.state?.mode === 'monitoring') return true;
      await sleep(1000);
    }
    return false;
  }
}

export async function emu<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`${EMU}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return (await r.json()) as T;
}

export async function emuAvailable(): Promise<boolean> {
  try {
    return (await fetch(`${EMU}/api/state`)).ok;
  } catch {
    return false;
  }
}
