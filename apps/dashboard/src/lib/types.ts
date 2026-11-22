/** Shapes of the data pushed by the backend (see services/backend/src/api/ws.ts). */
import type { DeviceId, SensorId } from '@twin/contracts/devices';

export interface PumpState {
  on: boolean;
  duty: number;
}

export type { DeviceId, SensorId };

export interface LiveTelemetry {
  deviceId: DeviceId;
  ts: number;
  receivedAt: number;
  seq: number;
  sensors: Partial<Record<SensorId, { v: number | null; q: string }>>;
  pump?: PumpState;
  rssi: number;
}

export interface DeviceStatus {
  deviceId: DeviceId;
  online: boolean;
  reason?: string;
  bootId?: string;
  fw?: string;
  receivedAt: number;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: number;
  key: string;
  type: 'leak' | 'theft' | 'fdi' | 'sensor_fault' | 'device_offline' | 'security' | 'model';
  severity: Severity;
  state: 'active' | 'acknowledged' | 'resolved';
  segment: string | null;
  device_id: string | null;
  sensor_id: string | null;
  message: string;
  data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  acknowledged_by: string | null;
  resolved_at: string | null;
}

export interface EventRow {
  id: number;
  time: string;
  kind: string;
  severity: Severity;
  device_id: string | null;
  message: string;
  data: unknown;
}

/** Twin state (filled in Phase 4). */
export interface TwinState {
  ts: number;
  mode: string;
  segments: Record<string, { state: 'normal' | 'warning' | 'leak' | 'theft' | 'unknown'; score?: number }>;
  [k: string]: unknown;
}

export interface CommandUpdate {
  cmdId: string;
  deviceId: DeviceId;
  type: string;
  params: unknown;
  status: string;
  issuedBy: string;
  reason?: string;
  latencyMs?: number;
  verified?: boolean;
  createdAt?: number;
}
