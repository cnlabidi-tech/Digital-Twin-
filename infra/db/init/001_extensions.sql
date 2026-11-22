-- =============================================================================
-- Runs once, when the database volume is first created.
-- Phase 0: only enable TimescaleDB. Tables and hypertables are created in
-- Phase 2 by the ingestion service migrations.
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;
