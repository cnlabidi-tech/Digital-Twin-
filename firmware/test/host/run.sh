#!/usr/bin/env bash
# Host tests of the firmware library: TypeScript vectors -> g++ -> run.
set -euo pipefail
cd "$(dirname "$0")"
npx tsx gen-vectors.ts
g++ -std=c++17 -O1 -Wall -Wextra -DTWIN_HOST -o /tmp/twin_host_test \
  test_main.cpp ../../lib/twin/src/twin_crypto.cpp ../../lib/twin/src/twin_protocol.cpp ../../lib/twin/src/twin_sensors.cpp \
  -lcrypto
/tmp/twin_host_test
# Firmware conformance: real src/main.cpp on simulated hardware, checked by the platform validators
npx tsx conformance.ts
