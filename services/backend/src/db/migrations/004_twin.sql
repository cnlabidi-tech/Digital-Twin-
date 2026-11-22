-- =============================================================================
-- 004 - Digital twin model and state (Phase 4)
-- twin_model : learned model parameters (one active row). Learning again
--              (after maintenance / calibration) deactivates the old one.
-- twin_state : 1 Hz history of the twin's reasoning: residuals, CUSUM,
--              diagnosis. Used for the dashboard and the Phase 9 evaluation.
-- =============================================================================
CREATE TABLE twin_model (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  active     boolean NOT NULL DEFAULT true,
  params     jsonb NOT NULL
);
CREATE UNIQUE INDEX twin_model_one_active ON twin_model (active) WHERE active;

CREATE TABLE twin_state (
  time        timestamptz NOT NULL,
  mode        text NOT NULL,
  loss_lpm    double precision,
  z           jsonb,
  cusum_pos   double precision,
  cusum_neg   double precision,
  hypothesis  text,
  segment     text,
  position_m  double precision,
  suspects    text[]
);
SELECT create_hypertable('twin_state', 'time', chunk_time_interval => INTERVAL '1 day');
SELECT add_retention_policy('twin_state', INTERVAL '30 days');
