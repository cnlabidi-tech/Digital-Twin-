/**
 * Device and sensor registry - the static description of the physical system.
 *
 * Every component (emulator, backend, dashboard, firmware docs) uses this file
 * to know which device owns which sensor, its unit and its valid range.
 */

/** Contract version carried in every message as field `v`. */
export const CONTRACT_VERSION = 1 as const;

/** The two field devices. Unknown device ids are rejected by validation. */
export const DEVICE_IDS = ['node-inlet', 'node-downstream'] as const;
export type DeviceId = (typeof DEVICE_IDS)[number];

export const SENSOR_IDS = ['P1', 'P2', 'P3', 'F1', 'F2'] as const;
export type SensorId = (typeof SENSOR_IDS)[number];

export type SensorKind = 'pressure' | 'flow';

export interface SensorSpec {
  id: SensorId;
  kind: SensorKind;
  device: DeviceId;
  /** Engineering unit of the `v` field. */
  unit: 'bar' | 'L/min';
  /** Meaning of the `raw` field (what the firmware actually measured). */
  raw: 'ads1115_counts' | 'pulse_count_total';
  /** Physically valid range of the engineering value. */
  min: number;
  max: number;
  description: string;
}

/**
 * Sensor table. Pressure is GAUGE pressure (0 = atmosphere).
 * Flow `raw` is the cumulative pulse count since boot: integrating it gives a
 * volume, which makes mass balance robust to timing jitter (see docs).
 */
export const SENSORS: Record<SensorId, SensorSpec> = {
  P1: { id: 'P1', kind: 'pressure', device: 'node-inlet', unit: 'bar', raw: 'ads1115_counts', min: 0, max: 10, description: 'Inlet pressure, after pump' },
  F1: { id: 'F1', kind: 'flow', device: 'node-inlet', unit: 'L/min', raw: 'pulse_count_total', min: 0, max: 30, description: 'Inlet flow (YF-S201)' },
  P2: { id: 'P2', kind: 'pressure', device: 'node-downstream', unit: 'bar', raw: 'ads1115_counts', min: 0, max: 10, description: 'Mid-line pressure' },
  P3: { id: 'P3', kind: 'pressure', device: 'node-downstream', unit: 'bar', raw: 'ads1115_counts', min: 0, max: 10, description: 'Outlet pressure' },
  F2: { id: 'F2', kind: 'flow', device: 'node-downstream', unit: 'L/min', raw: 'pulse_count_total', min: 0, max: 30, description: 'Outlet flow (YF-S201)' },
};

/** Sensors that each device must report in every telemetry message. */
export const DEVICE_SENSORS: Record<DeviceId, SensorId[]> = {
  'node-inlet': ['P1', 'F1'],
  'node-downstream': ['P2', 'P3', 'F2'],
};

/** Only the inlet node has an actuator (the pump). */
export const DEVICE_HAS_PUMP: Record<DeviceId, boolean> = {
  'node-inlet': true,
  'node-downstream': false,
};

/**
 * Pipeline topology: position of each sensor along the pipe, in metres from
 * the pump outlet. Two monitored segments: A = P1..P2, B = P2..P3.
 * NOTE: nominal values - replace with the measured lengths in Phase 8.
 */
export const DEFAULT_TOPOLOGY = {
  positionsM: { P1: 0.0, F1: 0.15, P2: 2.0, P3: 4.0, F2: 4.15 } as Record<SensorId, number>,
  segments: {
    A: { from: 'P1', to: 'P2' },
    B: { from: 'P2', to: 'P3' },
  } as const,
};
export type SegmentId = keyof typeof DEFAULT_TOPOLOGY.segments;
