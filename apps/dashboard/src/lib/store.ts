/**
 * Live store: one WebSocket to the backend, an in-memory model of the plant,
 * and ring buffers of recent samples for the charts.
 *
 * React components subscribe with `useLive(selector)` (useSyncExternalStore).
 * Updates are batched to one notification per animation frame, so 4+ messages
 * per second never cause more than ~60 renders per second.
 */
import { useSyncExternalStore } from 'react';
import type { Alert, CommandUpdate, DeviceId, DeviceStatus, EventRow, LiveTelemetry, SensorId, TwinState } from './types';

export const SERIES_MAX_POINTS = 4000; // ~33 min at 2 Hz

export interface Series {
  t: number[]; // seconds (uPlot uses seconds)
  v: (number | null)[];
}

export interface LiveData {
  connected: boolean;
  latest: Partial<Record<DeviceId, LiveTelemetry>>;
  devices: Partial<Record<DeviceId, DeviceStatus>>;
  alerts: Record<number, Alert>; // open alerts
  events: EventRow[]; // newest first, pushed live
  twin: TwinState | null;
  commands: CommandUpdate[]; // newest first
  series: Record<SensorId, Series>;
  /** Extra derived series from the twin (Phase 4), e.g. residuals. */
  twinSeries: Record<string, Series>;
  version: number;
}

const emptySeries = (): Series => ({ t: [], v: [] });

const state: LiveData = {
  connected: false,
  latest: {},
  devices: {},
  alerts: {},
  events: [],
  twin: null,
  commands: [],
  series: { P1: emptySeries(), P2: emptySeries(), P3: emptySeries(), F1: emptySeries(), F2: emptySeries() },
  twinSeries: {},
  version: 0,
};

const listeners = new Set<() => void>();
let scheduled = false;
function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    state.version++;
    for (const l of listeners) l();
  });
}

export function push(s: Series, t: number, v: number | null) {
  s.t.push(t);
  s.v.push(v);
  if (s.t.length > SERIES_MAX_POINTS) {
    s.t.splice(0, s.t.length - SERIES_MAX_POINTS);
    s.v.splice(0, s.v.length - SERIES_MAX_POINTS);
  }
}

function onTelemetry(t: LiveTelemetry) {
  state.latest = { ...state.latest, [t.deviceId]: t };
  for (const [id, r] of Object.entries(t.sensors)) push(state.series[id as SensorId], t.ts / 1000, r?.v ?? null);
}

function onTwin(t: TwinState) {
  state.twin = t;
  const series = (t.series ?? {}) as Record<string, number | null>;
  for (const [k, v] of Object.entries(series)) push((state.twinSeries[k] ??= emptySeries()), t.ts / 1000, v);
}

function onAlert(a: Alert) {
  const next = { ...state.alerts };
  if (a.state === 'resolved') delete next[a.id];
  else next[a.id] = a;
  state.alerts = next;
}

function onCommand(c: CommandUpdate) {
  const rest = state.commands.filter((x) => x.cmdId !== c.cmdId);
  state.commands = [c, ...rest].slice(0, 50);
}

type Msg =
  | { type: 'snapshot'; data: { latest: LiveData['latest']; devices: LiveData['devices']; alerts: Alert[]; twin: TwinState | null } }
  | { type: 'telemetry'; data: LiveTelemetry }
  | { type: 'status'; data: DeviceStatus }
  | { type: 'alert'; data: Alert }
  | { type: 'event'; data: EventRow }
  | { type: 'twin'; data: TwinState }
  | { type: 'command'; data: CommandUpdate }
  | { type: 'ack'; data: unknown };

function handle(m: Msg) {
  switch (m.type) {
    case 'snapshot':
      state.latest = m.data.latest ?? {};
      state.devices = m.data.devices ?? {};
      state.alerts = Object.fromEntries((m.data.alerts ?? []).map((a) => [a.id, a]));
      if (m.data.twin) state.twin = m.data.twin;
      break;
    case 'telemetry':
      onTelemetry(m.data);
      break;
    case 'status':
      state.devices = { ...state.devices, [m.data.deviceId]: m.data };
      break;
    case 'alert':
      onAlert(m.data);
      break;
    case 'event':
      state.events = [m.data, ...state.events].slice(0, 500);
      break;
    case 'twin':
      onTwin(m.data);
      break;
    case 'command':
      onCommand(m.data);
      break;
  }
  notify();
}

/** Connect (and keep reconnecting) to the backend WebSocket. */
export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = localStorage.getItem('twin.token');
  const url = `${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const ws = new WebSocket(url);
  ws.onopen = () => {
    state.connected = true;
    notify();
  };
  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data as string) as Msg);
    } catch {
      /* ignore malformed frame */
    }
  };
  ws.onclose = (e) => {
    state.connected = false;
    notify();
    // 4401 = token missing/expired: go back to the login screen instead of retrying.
    if (e.code === 4401) {
      localStorage.removeItem('twin.token');
      window.dispatchEvent(new Event('twin:unauthorized'));
      return;
    }
    setTimeout(connect, 2000);
  };
}

/** Seed the history panel and the charts from REST on start-up. */
export async function bootstrap(fetchJson: <T>(p: string) => Promise<T>): Promise<void> {
  try {
    const [events, hist] = await Promise.all([
      fetchJson<EventRow[]>('/api/events?limit=200'),
      fetchJson<Array<{ time: string; sensor_id: SensorId; value: number | null }>>('/api/telemetry?bucket=raw&limit=20000'),
    ]);
    state.events = [...state.events, ...events.filter((e) => !state.events.some((x) => x.id === e.id))];
    for (const s of Object.values(state.series)) {
      s.t.length = 0;
      s.v.length = 0;
    }
    for (const r of hist) push(state.series[r.sensor_id], new Date(r.time).getTime() / 1000, r.value);
    notify();
  } catch {
    /* backend not reachable yet: live data will fill in */
  }
}

export function useLive<T>(selector: (s: LiveData) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

export const getState = () => state;
