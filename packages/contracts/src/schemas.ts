/**
 * JSON Schemas (generated with TypeBox) and the matching TypeScript types.
 *
 * Design rules:
 *  - `additionalProperties: false` everywhere: unknown fields are rejected
 *    (a strict parser is the first defence against malformed/forged input).
 *  - Every message carries the same security envelope:
 *      v      contract version
 *      ts     device/platform clock, Unix epoch milliseconds (NTP synced)
 *      nonce  16 hex chars, random per message           -> anti-replay
 *      sig    HMAC-SHA256 (64 hex), ALWAYS the last field -> integrity
 *    `sig` is optional in the schema until Phase 6, where the backend makes it
 *    mandatory. See signing.ts for the exact signed bytes.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { DEVICE_IDS } from './devices';

// ---------------------------------------------------------------- primitives
const Lits = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v)) as never) as unknown as TSchema;

export const DeviceIdSchema = Type.Union(DEVICE_IDS.map((d) => Type.Literal(d)));
const Version = Type.Literal(1);
const Timestamp = Type.Integer({ minimum: 1_600_000_000_000, description: 'Unix epoch, ms' });
const Nonce = Type.String({ pattern: '^[0-9a-f]{16}$', description: '64-bit random, hex' });
const Signature = Type.String({ pattern: '^[0-9a-f]{64}$', description: 'HMAC-SHA256, hex' });
const BootId = Type.String({ pattern: '^[0-9a-f]{8}$', description: 'Random id chosen at each boot' });
const CmdId = Type.String({ pattern: '^[A-Za-z0-9-]{8,64}$' });

export const SensorQualitySchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('out_of_range'), // e.g. transducer < 1 V => wire broken / sensor unpowered
  Type.Literal('fault'), // ADC not responding, etc.
]);

export const SensorReadingSchema = Type.Object(
  {
    v: Type.Union([Type.Number(), Type.Null()], { description: 'Engineering value (bar or L/min); null if unusable' }),
    raw: Type.Integer({ description: 'ADS1115 counts (pressure) or cumulative pulses since boot (flow)' }),
    q: SensorQualitySchema,
  },
  { additionalProperties: false },
);

export const PumpStateSchema = Type.Object(
  {
    on: Type.Boolean(),
    duty: Type.Integer({ minimum: 0, maximum: 100, description: 'PWM duty, %' }),
  },
  { additionalProperties: false },
);

// ----------------------------------------------------------------- telemetry
export const TelemetrySchema = Type.Object(
  {
    v: Version,
    deviceId: DeviceIdSchema,
    bootId: BootId,
    seq: Type.Integer({ minimum: 0, maximum: 4294967295, description: 'Per-boot message counter' }),
    ts: Timestamp,
    nonce: Nonce,
    intervalMs: Type.Integer({ minimum: 100, maximum: 60000, description: 'Averaging window of this sample' }),
    sensors: Type.Record(Type.String({ pattern: '^(P[1-3]|F[1-2])$' }), SensorReadingSchema),
    actuators: Type.Optional(Type.Object({ pump: PumpStateSchema }, { additionalProperties: false })),
    diag: Type.Object(
      {
        uptimeS: Type.Integer({ minimum: 0 }),
        rssi: Type.Integer({ minimum: -127, maximum: 0, description: 'Wi-Fi RSSI, dBm' }),
        heapFree: Type.Integer({ minimum: 0 }),
        ntpSynced: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    sig: Type.Optional(Signature),
  },
  { additionalProperties: false, $id: 'Telemetry' },
);

// -------------------------------------------------------------------- status
export const StatusSchema = Type.Object(
  {
    v: Version,
    deviceId: DeviceIdSchema,
    online: Type.Boolean(),
    ts: Type.Optional(Timestamp), // absent in the last-will message (written at connect time)
    bootId: Type.Optional(BootId),
    fw: Type.Optional(Type.String({ maxLength: 32 })),
    reason: Type.Optional(Type.Union([Type.Literal('boot'), Type.Literal('lwt'), Type.Literal('shutdown')])),
    sig: Type.Optional(Signature),
  },
  { additionalProperties: false, $id: 'Status' },
);

// ------------------------------------------------------------------ commands
const commandBase = {
  v: Version,
  cmdId: CmdId,
  deviceId: DeviceIdSchema,
  ts: Timestamp,
  nonce: Nonce,
  issuedBy: Type.String({ minLength: 1, maxLength: 64, description: 'e.g. user:alice or auto:detector' }),
};

export const PumpSetCommandSchema = Type.Object(
  {
    ...commandBase,
    type: Type.Literal('pump.set'),
    params: Type.Object(
      { on: Type.Boolean(), duty: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })) },
      { additionalProperties: false },
    ),
    sig: Type.Optional(Signature),
  },
  { additionalProperties: false },
);

export const SetIntervalCommandSchema = Type.Object(
  {
    ...commandBase,
    type: Type.Literal('telemetry.set_interval'),
    params: Type.Object(
      { intervalMs: Type.Integer({ minimum: 200, maximum: 10000 }) },
      { additionalProperties: false },
    ),
    sig: Type.Optional(Signature),
  },
  { additionalProperties: false },
);

export const PingCommandSchema = Type.Object(
  {
    ...commandBase,
    type: Type.Literal('ping'),
    params: Type.Object({}, { additionalProperties: false }),
    sig: Type.Optional(Signature),
  },
  { additionalProperties: false },
);

export const CommandSchema = Type.Union([PumpSetCommandSchema, SetIntervalCommandSchema, PingCommandSchema], {
  $id: 'Command',
});

export const COMMAND_TYPES = ['pump.set', 'telemetry.set_interval', 'ping'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

// ---------------------------------------------------------------------- acks
export const ACK_REJECT_REASONS = [
  'bad_signature',
  'missing_signature',
  'stale_timestamp',
  'replayed_nonce',
  'wrong_device',
  'unknown_command',
  'invalid_params',
  'not_supported',
  'interlock',
] as const;

export const AckSchema = Type.Object(
  {
    v: Version,
    cmdId: CmdId,
    deviceId: DeviceIdSchema,
    ts: Timestamp,
    nonce: Nonce,
    status: Type.Union([Type.Literal('executed'), Type.Literal('rejected')]),
    reason: Type.Optional(Lits(ACK_REJECT_REASONS)),
    state: Type.Optional(
      Type.Object(
        { pump: Type.Optional(PumpStateSchema), intervalMs: Type.Optional(Type.Integer()) },
        { additionalProperties: false },
      ),
    ),
    sig: Type.Optional(Signature),
  },
  { additionalProperties: false, $id: 'Ack' },
);

// --------------------------------------------------------------------- types
export type SensorQuality = Static<typeof SensorQualitySchema>;
export type SensorReading = Static<typeof SensorReadingSchema>;
export type PumpState = Static<typeof PumpStateSchema>;
export type Telemetry = Static<typeof TelemetrySchema>;
export type Status = Static<typeof StatusSchema>;
export type PumpSetCommand = Static<typeof PumpSetCommandSchema>;
export type SetIntervalCommand = Static<typeof SetIntervalCommandSchema>;
export type PingCommand = Static<typeof PingCommandSchema>;
export type Command = Static<typeof CommandSchema>;
export type AckRejectReason = (typeof ACK_REJECT_REASONS)[number];
export type Ack = Omit<Static<typeof AckSchema>, 'reason'> & { reason?: AckRejectReason };
