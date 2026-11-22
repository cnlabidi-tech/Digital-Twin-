#!/usr/bin/env bash
# =============================================================================
# Infrastructure smoke test (works in both security modes).
#   1. Broker and database containers are healthy
#   2. MQTT: secure mode -> anonymous refused, "monitor" account accepted over TLS
#            dev mode    -> publish/subscribe round trip
#   3. TimescaleDB extension is installed
# Usage:  bash scripts/smoke-test.sh      (stack must be up: docker compose up -d)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="$(grep -E '^SECURITY_MODE=' .env 2>/dev/null | cut -d= -f2 || true)"
MODE="${MODE:-secure}"
DB_USER="${POSTGRES_USER:-twin}"
DB_NAME="${POSTGRES_DB:-pipeline_twin}"
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

echo "[1/3] Container health (security mode: $MODE)"
for svc in twin-mosquitto twin-timescaledb; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo missing)"
  [[ "$status" == "healthy" ]] && pass "$svc is healthy" || fail "$svc status: $status (wait a few seconds and retry)"
done

echo "[2/3] MQTT broker"
if [[ "$MODE" == "secure" ]]; then
  [[ -f secrets/mqtt-credentials.json ]] || fail "secrets missing: run npm run setup -w @twin/security"
  MON_PW="$(sed -n 's/.*"monitor": *"\([^"]*\)".*/\1/p' secrets/mqtt-credentials.json)"
  if docker exec twin-mosquitto mosquitto_sub -h localhost -p 8883 --cafile /mosquitto/secrets/ca.crt \
       -t 'pipeline/v1/#' -C 1 -W 3 >/dev/null 2>&1; then
    fail "anonymous TLS connection was accepted"
  else
    pass "anonymous connection refused"
  fi
  # exit code 27 = connected but no message within -W seconds (no device running): still a successful login
  set +e
  docker exec twin-mosquitto mosquitto_sub -h localhost -p 8883 --cafile /mosquitto/secrets/ca.crt \
    -u monitor -P "$MON_PW" -i monitor -t 'pipeline/v1/#' -C 1 -W 3 >/dev/null 2>&1
  rc=$?
  set -e
  [[ $rc -eq 0 || $rc -eq 27 ]] && pass "TLS login with the monitor account works" || fail "monitor login failed (exit $rc)"
else
  docker exec twin-mosquitto sh -c \
    'mosquitto_sub -h localhost -t smoke/test -C 1 -W 5 > /tmp/smoke.out & sleep 1;
     mosquitto_pub -h localhost -t smoke/test -m "hello-twin"; wait; cat /tmp/smoke.out' \
    | grep -q "hello-twin" && pass "message received through broker" || fail "no MQTT message received"
fi

echo "[3/3] TimescaleDB extension"
ver="$(docker exec twin-timescaledb psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT extversion FROM pg_extension WHERE extname='timescaledb';")"
[[ -n "$ver" ]] && pass "timescaledb $ver installed in $DB_NAME" || fail "timescaledb extension missing"

echo "All infrastructure checks passed."
