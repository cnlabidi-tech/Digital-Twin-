-- =============================================================================
-- 001 - Telemetry storage (Phase 2)
-- -----------------------------------------------------------------------------
-- Two hypertables (TimescaleDB partitions them by time automatically):
--   telemetry_messages : one row per MQTT telemetry message (envelope + diag)
--   sensor_readings    : one row per sensor value ("long" format: easy to query
--                        one sensor, and adding a sensor needs no schema change)
-- `time` is the DEVICE timestamp (what the twin reasons on); `received_at` is
-- the platform clock, kept to measure latency and detect clock problems.
-- =============================================================================

CREATE TABLE devices (
  device_id     text PRIMARY KEY,
  online        boolean NOT NULL DEFAULT false,
  boot_id       text,
  fw            text,
  last_seen     timestamptz,
  last_status   timestamptz,
  status_reason text
);
INSERT INTO devices(device_id) VALUES ('node-inlet'), ('node-downstream');

CREATE TABLE telemetry_messages (
  time         timestamptz NOT NULL,
  received_at  timestamptz NOT NULL,
  device_id    text        NOT NULL,
  boot_id      text        NOT NULL,
  seq          bigint      NOT NULL,
  nonce        text        NOT NULL,
  interval_ms  integer     NOT NULL,
  pump_on      boolean,
  pump_duty    smallint,
  rssi         smallint,
  uptime_s     integer,
  heap_free    integer,
  ntp_synced   boolean,
  signed       boolean     NOT NULL DEFAULT false
);
SELECT create_hypertable('telemetry_messages', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON telemetry_messages (device_id, time DESC);

CREATE TABLE sensor_readings (
  time        timestamptz NOT NULL,
  device_id   text        NOT NULL,
  sensor_id   text        NOT NULL,
  value       double precision,           -- NULL when quality is not ok
  raw         bigint      NOT NULL,       -- ADC counts or cumulative pulses
  quality     text        NOT NULL
);
SELECT create_hypertable('sensor_readings', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON sensor_readings (sensor_id, time DESC);

-- Status changes (online/offline, boots, last-will).
CREATE TABLE device_status_log (
  time       timestamptz NOT NULL DEFAULT now(),
  device_id  text NOT NULL,
  online     boolean NOT NULL,
  reason     text,
  boot_id    text,
  fw         text
);
CREATE INDEX ON device_status_log (device_id, time DESC);

-- Messages the platform refused (malformed, invalid, later: bad signature,
-- replay...). Kept for security monitoring and the thesis evaluation.
CREATE TABLE rejected_messages (
  time       timestamptz NOT NULL DEFAULT now(),
  topic      text NOT NULL,
  device_id  text,
  channel    text,
  reason     text NOT NULL,
  details    jsonb,
  payload    text            -- truncated to 2 KB
);
SELECT create_hypertable('rejected_messages', 'time', chunk_time_interval => INTERVAL '7 days');

-- Keep raw high-rate data 30 days (the 1-minute aggregate below is kept forever).
SELECT add_retention_policy('sensor_readings', INTERVAL '30 days');
SELECT add_retention_policy('telemetry_messages', INTERVAL '30 days');
