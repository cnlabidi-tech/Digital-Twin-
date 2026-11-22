# services/backend

Node.js + TypeScript **modular monolith**. Modules talk through an in-process
event bus (`src/bus.ts`).

| Module | Folder | Phase |
|--------|--------|-------|
| Ingestion: MQTT subscribe, validate, store | `src/ingestion/` | 2 |
| Database pool + migrations | `src/db/` | 2 |
| REST + WebSocket API | `src/api/` | 2-3 |
| Twin model + detection | `src/twin/` | 4 |
| Control (commands, acks) | `src/control/` | 5 |
| Security (signatures, anti-replay, FDI, auth, audit) | `src/security/` | 6 |

## Ingestion pipeline

```
MQTT message -> topic in contract? -> size <= 8 KB -> JSON -> deviceId(payload) == deviceId(topic)
             -> JSON Schema + semantic rules -> [security gate, Phase 6] -> bus
bus -> StorageWriter (batched INSERT every 1 s) -> TimescaleDB
any failure -> rejected_messages table + counter in /api/health
```

## Storage (TimescaleDB)

| Table | Type | Content |
|-------|------|---------|
| `telemetry_messages` | hypertable | one row per message: envelope, pump state, diagnostics |
| `sensor_readings` | hypertable | one row per sensor value (long format) |
| `sensor_readings_1m` | continuous aggregate | 1-minute avg/min/max, refreshed every minute |
| `devices` | table | current online state, boot id, firmware, last seen |
| `device_status_log` | table | every online/offline/boot/last-will event |
| `rejected_messages` | hypertable | refused messages with reason (security evidence) |

Raw data retention: 30 days. `time` = device clock, `received_at` = platform clock.

## Endpoints (Phase 2)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | MQTT state + ingestion counters |
| GET | `/api/devices` | device registry |
| GET | `/api/telemetry/latest` | last value of each sensor |
| GET | `/api/telemetry?sensor=P1,F1&from=&to=&bucket=raw\|1s\|5s\|1m\|10m` | history |
| GET | `/api/rejected?limit=50` | last rejected messages |

## Run locally (without Docker)

```bash
docker compose up -d mosquitto timescaledb
npm start -w @twin/backend        # migrations run automatically
```
