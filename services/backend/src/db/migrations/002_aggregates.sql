-- no-transaction
-- 002 - 1-minute continuous aggregate for long-range charts (Phase 2)
-- Continuous aggregates must be created outside a transaction (see migrate.ts)
CREATE MATERIALIZED VIEW sensor_readings_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
       sensor_id,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value,
       count(*)   AS samples
FROM sensor_readings
GROUP BY bucket, sensor_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('sensor_readings_1m',
  start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '1 minute');
