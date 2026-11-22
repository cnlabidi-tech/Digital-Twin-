# Data contract (v1)

Single source of truth: [`packages/contracts`](../packages/contracts/src).
Machine-readable JSON Schemas: [`docs/contracts/`](contracts/) (regenerate with
`npm run export-schemas -w @twin/contracts`). The ESP32 firmware (Phase 7)
must produce byte-for-byte the same structures.

## 1. Devices and sensors

| Device id | Sensors | Actuator |
|-----------|---------|----------|
| `node-inlet` (ESP32 #1) | `P1` pressure, `F1` flow | pump (on/off + PWM duty) |
| `node-downstream` (ESP32 #2) | `P2` pressure (mid-line), `P3` pressure, `F2` flow | - |

- Pressure: **bar, gauge** (0 = atmosphere). `raw` = averaged ADS1115 counts.
- Flow: **L/min**. `raw` = **cumulative pulse count since boot** (YF-S201).
  Two consecutive messages give an exact volume: `dV = d(raw) / (K * 60)` litres.
  This is more accurate than averaging the instantaneous flows, because pulse
  quantisation (1 pulse = 0.27 L/min in a 0.5 s window) cancels out.

## 2. Topics

| Topic | Direction | QoS | Retained |
|-------|-----------|-----|----------|
| `pipeline/v1/<deviceId>/telemetry` | device -> platform | 0 | no |
| `pipeline/v1/<deviceId>/status` | device -> platform (+ last will) | 1 | **yes** |
| `pipeline/v1/<deviceId>/cmd` | platform -> device | 1 | no (never: a retained command would replay at every reconnect) |
| `pipeline/v1/<deviceId>/ack` | device -> platform | 1 | no |

The device id is a topic level so that broker ACLs (Phase 6) can confine each
device to `pipeline/v1/<its id>/#`.

## 3. Common security envelope

Every message (except the last-will) carries:

| Field | Type | Purpose |
|-------|------|---------|
| `v` | `1` | Contract version |
| `ts` | integer, Unix ms | Sender clock (NTP). Freshness window check |
| `nonce` | 16 hex chars | Random per message. Replay detection (nonce cache) |
| `sig` | 64 hex chars, **always the last field** | HMAC-SHA256 with the device key |

**Signed bytes**: the compact JSON *without* `sig`. The sender serialises,
computes the HMAC, then inserts `,"sig":"<hex>"` before the final `}`. The
receiver removes exactly that suffix and recomputes. No JSON canonicalisation
is needed, so C++ and TypeScript cannot disagree.
`sig` is optional until Phase 6 makes it mandatory.

## 4. Messages

### Telemetry (every `intervalMs`, default 500 ms)

```json
{
  "v": 1, "deviceId": "node-downstream", "bootId": "496d57d5", "seq": 17,
  "ts": 1795363451957, "nonce": "09a9dbeee855cb1f", "intervalMs": 500,
  "sensors": {
    "P2": { "v": 3.612, "raw": 18321, "q": "ok" },
    "P3": { "v": 3.127, "raw": 17532, "q": "ok" },
    "F2": { "v": 3.466, "raw": 1203, "q": "ok" }
  },
  "diag": { "uptimeS": 8, "rssi": -52, "heapFree": 191230, "ntpSynced": true },
  "sig": "…64 hex…"
}
```

- `bootId` changes at every reboot, `seq` restarts at 0: the platform can tell
  a reboot from lost or replayed messages.
- `q` (quality): `ok`, `out_of_range` (transducer below 0.9 V or above 5.1 V:
  broken wire / unpowered - the live-zero principle of 1-5 V sensors), `fault`.
  When `q` is not `ok`, `v` is `null`.
- `node-inlet` also sends `"actuators": { "pump": { "on": true, "duty": 100 } }`.

### Status (retained)

```json
{ "v": 1, "deviceId": "node-inlet", "online": true, "ts": 1795363451958,
  "bootId": "1b9247ca", "fw": "1.0.0", "reason": "boot", "sig": "…" }
```

Last will, registered at connect and published by the broker if the device
disappears (keep-alive 10 s): `{"v":1,"deviceId":"node-inlet","online":false,"reason":"lwt"}`.

### Command

```json
{ "v": 1, "cmdId": "m3x9k2-a1b2c3d4e5f6", "deviceId": "node-inlet",
  "ts": 1795363468353, "nonce": "0123456789abcdef", "issuedBy": "user:alice",
  "type": "pump.set", "params": { "on": false }, "sig": "…" }
```

| `type` | `params` | Device |
|--------|----------|--------|
| `pump.set` | `{ "on": bool, "duty"?: 0-100 }` | inlet only |
| `telemetry.set_interval` | `{ "intervalMs": 200-10000 }` | both |
| `ping` | `{}` | both |

Checks done by the device, in order: JSON + schema, `deviceId` is mine,
signature, `|device clock - ts| <= 30 s`, nonce not seen in the last 60 s.

### Acknowledgement

```json
{ "v": 1, "cmdId": "m3x9k2-a1b2c3d4e5f6", "deviceId": "node-inlet",
  "ts": 1795363468451, "nonce": "09a9dbeee855cb1f", "status": "executed",
  "state": { "pump": { "on": false, "duty": 100 }, "intervalMs": 500 }, "sig": "…" }
```

`status` = `executed` or `rejected` with `reason` in: `bad_signature`,
`missing_signature`, `stale_timestamp`, `replayed_nonce`, `wrong_device`,
`unknown_command`, `invalid_params`, `not_supported`, `interlock`.
`state` reports the device state after handling, so the platform can confirm
the effect (closed loop).

## 5. Validation levels

1. **Structural** (JSON Schema): types, ranges, patterns, *no unknown fields*.
2. **Semantic**: each device reports exactly its own sensors; only the inlet
   reports a pump; a physically impossible value cannot be flagged `ok`.
3. **Security** (Phase 6): signature, freshness, nonce, sequence.
4. **Physical** (Phases 4/6): consistency with the twin model (FDI detection).
