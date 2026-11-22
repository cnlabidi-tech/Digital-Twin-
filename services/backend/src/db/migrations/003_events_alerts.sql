-- =============================================================================
-- 003 - Alerts and event history (Phase 3)
-- -----------------------------------------------------------------------------
-- alerts : conditions that need an operator (leak, theft, attack, offline...).
--          Life cycle: active -> acknowledged (operator saw it) -> resolved
--          (condition gone). `key` de-duplicates: one active alert per key.
-- events : append-only timeline of everything notable (status changes,
--          rejected messages, alerts, commands...) for the history panel.
-- =============================================================================

CREATE TABLE alerts (
  id               bigserial PRIMARY KEY,
  key              text        NOT NULL,
  type             text        NOT NULL,  -- leak | theft | fdi | sensor_fault | device_offline | security | model
  severity         text        NOT NULL,  -- info | warning | critical
  state            text        NOT NULL DEFAULT 'active',  -- active | acknowledged | resolved
  segment          text,                  -- A | B (localisation) when known
  device_id        text,
  sensor_id        text,
  message          text        NOT NULL,
  data             jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  resolved_at      timestamptz
);
-- At most one non-resolved alert per key.
CREATE UNIQUE INDEX alerts_open_key ON alerts (key) WHERE state <> 'resolved';
CREATE INDEX ON alerts (created_at DESC);

CREATE TABLE events (
  id         bigserial,
  time       timestamptz NOT NULL DEFAULT now(),
  kind       text        NOT NULL,  -- device | security | alert | command | system
  severity   text        NOT NULL DEFAULT 'info',
  device_id  text,
  message    text        NOT NULL,
  data       jsonb,
  PRIMARY KEY (id, time)
);
SELECT create_hypertable('events', 'time', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX ON events (kind, time DESC);
