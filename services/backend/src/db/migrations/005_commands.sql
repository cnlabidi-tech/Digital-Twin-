-- =============================================================================
-- 005 - Commands sent to devices (Phase 5)
-- Life cycle: pending -> sent -> executed | rejected | timeout
-- `verified` = the effect was observed in later telemetry (closed loop).
-- =============================================================================
CREATE TABLE commands (
  cmd_id      text PRIMARY KEY,
  device_id   text NOT NULL,
  type        text NOT NULL,
  params      jsonb NOT NULL,
  issued_by   text NOT NULL,
  status      text NOT NULL,
  reason      text,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  acked_at    timestamptz,
  latency_ms  integer,
  ack         jsonb,
  verified    boolean NOT NULL DEFAULT false
);
CREATE INDEX ON commands (created_at DESC);

-- Persistent control policy (one row).
CREATE TABLE control_policy (
  id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_stop_on_leak   boolean NOT NULL DEFAULT true,
  auto_stop_on_theft  boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          text
);
INSERT INTO control_policy (id) VALUES (1);
