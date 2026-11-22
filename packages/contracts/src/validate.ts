/**
 * Runtime validation of incoming messages (Ajv compiled validators).
 *
 * Two levels:
 *  1. Structural: JSON Schema (types, ranges, no unknown fields).
 *  2. Semantic:   rules a schema cannot express, e.g. "node-inlet must report
 *                 exactly P1 and F1" or "only node-inlet may report a pump".
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { AckSchema, CommandSchema, StatusSchema, TelemetrySchema } from './schemas';
import type { Ack, Command, Status, Telemetry } from './schemas';
import { DEVICE_HAS_PUMP, DEVICE_SENSORS, SENSORS, type SensorId } from './devices';

const ajv = new Ajv({ allErrors: true, strict: false });

const vTelemetry = ajv.compile(TelemetrySchema);
const vStatus = ajv.compile(StatusSchema);
const vCommand = ajv.compile(CommandSchema);
const vAck = ajv.compile(AckSchema);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const fmt = (errs: ErrorObject[] | null | undefined): string[] =>
  (errs ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);

function run<T>(fn: ValidateFunction, input: unknown, semantic?: (v: T) => string[]): ValidationResult<T> {
  if (!fn(input)) return { ok: false, errors: fmt(fn.errors) };
  const extra = semantic ? semantic(input as T) : [];
  return extra.length ? { ok: false, errors: extra } : { ok: true, value: input as T };
}

/** Semantic checks for telemetry. */
function telemetryRules(t: Telemetry): string[] {
  const errors: string[] = [];
  const expected = DEVICE_SENSORS[t.deviceId];
  const got = Object.keys(t.sensors).sort();
  if (got.join(',') !== [...expected].sort().join(',')) {
    errors.push(`/sensors must be exactly [${expected.join(', ')}] for ${t.deviceId}, got [${got.join(', ')}]`);
  }
  for (const [id, r] of Object.entries(t.sensors)) {
    const spec = SENSORS[id as SensorId];
    if (spec && r.v !== null && (r.v < spec.min - 0.5 || r.v > spec.max + 0.5) && r.q === 'ok') {
      errors.push(`/sensors/${id}/v ${r.v} outside physical range but quality is "ok"`);
    }
  }
  if (t.actuators?.pump && !DEVICE_HAS_PUMP[t.deviceId]) errors.push(`/actuators ${t.deviceId} has no pump`);
  if (DEVICE_HAS_PUMP[t.deviceId] && !t.actuators?.pump) errors.push(`/actuators pump state is required for ${t.deviceId}`);
  return errors;
}

function commandRules(c: Command): string[] {
  if (c.type === 'pump.set' && !DEVICE_HAS_PUMP[c.deviceId]) return [`/deviceId ${c.deviceId} has no pump`];
  return [];
}

export const validateTelemetry = (x: unknown) => run<Telemetry>(vTelemetry, x, telemetryRules);
export const validateStatus = (x: unknown) => run<Status>(vStatus, x);
export const validateCommand = (x: unknown) => run<Command>(vCommand, x, commandRules);
export const validateAck = (x: unknown) => run<Ack>(vAck, x);

/** Parse raw MQTT bytes as JSON safely (never throws). */
export function parseJson(payload: Uint8Array | string): ValidationResult<unknown> {
  try {
    const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
}
