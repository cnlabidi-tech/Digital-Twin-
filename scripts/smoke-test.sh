#!/usr/bin/env bash
# =============================================================================
# Phase 0 smoke test: checks that the infrastructure stack is healthy.
#   1. Both containers are running and healthy
#   2. MQTT round-trip: a message published is received by a subscriber
#   3. TimescaleDB extension is installed in the project database
# Usage:  bash scripts/smoke-test.sh      (stack must be up: docker compose up -d)
# =============================================================================
set -euo pipefail

DB_USER="${POSTGRES_USER:-twin}"
DB_NAME="${POSTGRES_DB:-pipeline_twin}"
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

echo "[1/3] Container health"
for svc in twin-mosquitto twin-timescaledb; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo missing)"
  [[ "$status" == "healthy" ]] && pass "$svc is healthy" || fail "$svc status: $status (wait a few seconds and retry)"
done

echo "[2/3] MQTT publish/subscribe round-trip"
# Subscriber waits for exactly 1 message (-C 1) for at most 5 s (-W 5).
docker exec twin-mosquitto sh -c \
  'mosquitto_sub -h localhost -t smoke/test -C 1 -W 5 > /tmp/smoke.out & sleep 1;
   mosquitto_pub -h localhost -t smoke/test -m "hello-twin"; wait; cat /tmp/smoke.out' \
  | grep -q "hello-twin" && pass "message received through broker" || fail "no MQTT message received"

echo "[3/3] TimescaleDB extension"
ver="$(docker exec twin-timescaledb psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT extversion FROM pg_extension WHERE extname='timescaledb';")"
[[ -n "$ver" ]] && pass "timescaledb $ver installed in $DB_NAME" || fail "timescaledb extension missing"

echo "All Phase 0 checks passed."
