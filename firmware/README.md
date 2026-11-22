# firmware

ESP32-S3 node firmware (Arduino framework, PlatformIO). **One source, two roles**
selected at build time:

| Env | Board | Sensors / actuator |
|-----|-------|--------------------|
| `inlet` | ESP32 #1 | P1 (ADS1115 A0), F1 (GPIO 4), pump PWM (GPIO 6 -> D4184) |
| `downstream` | ESP32 #2 | P2 (A0), P3 (A1), F2 (GPIO 4) |

Wiring: [docs/hardware-wiring.md](../docs/hardware-wiring.md).

```
src/main.cpp              node application (sampling, telemetry, commands, fail-safe, serial console)
include/config.h          pins, timings
include/secrets_*.h       generated per board (git-ignored)
lib/twin/                 portable library
  twin_protocol.*         exact-bytes HMAC signing/verification, nonce cache, freshness
  twin_sensors.*          ADC counts -> bar, pulses -> L/min (same as the emulator)
  twin_crypto.*           HMAC-SHA256 (mbedTLS on device, OpenSSL in host tests)
  twin_calib.*            calibration constants in NVS, serial "cal" commands
test/host/                host tests (g++), no board needed
```

## Build and flash

```bash
npm run setup -w @twin/security -- --san <PC LAN IP> --force     # certificate must cover the PC address
docker compose restart mosquitto
npm run firmware-secrets -w @twin/security -- --ssid <wifi> --wifi-pass <pw> --broker <PC LAN IP>
cd firmware
pio run -e inlet -t upload         # board #1 on USB
pio run -e downstream -t upload    # board #2
pio device monitor                 # serial console (115200)
```

Serial console: `status`, `cal show`, `cal set P1.offset 0.02`, `cal set F1.k 7.6`,
`cal set divider 0.6652`, `cal save`, `raw on|off`.

## Behaviour

- Samples the ADS1115 at 50 Hz per channel, averages over the telemetry window.
- Flow from a debounced interrupt pulse counter; `raw` = cumulative pulses since boot.
- Publishes only when the clock is NTP-synchronised (otherwise the platform would
  reject the timestamps).
- Commands: schema -> device id -> HMAC -> freshness (±30 s) -> nonce -> execute -> signed ack.
- **Pump OFF at boot** (safe state). **Fail-safe**: pump stopped if the platform is
  unreachable for 120 s (`LINK_LOSS_PUMP_STOP_S`).
- Calibration only through USB serial (physical access), never over the network:
  a remote calibration command would be a perfect false-data-injection channel.
- Task watchdog: reboot if the loop hangs 30 s.

## Tests without hardware

```bash
npm run test:firmware      # = firmware/test/host/run.sh
```

1. **Cross-language vectors**: the TypeScript platform code generates signatures and
   conversions; the C++ library must reproduce them byte for byte (29 checks).
2. **Conformance**: the real `main.cpp` is compiled for both roles against simulated
   hardware, run, sent signed / tampered / unsigned / replayed / stale commands, and
   every published message is checked with the platform's own validators (25 checks).
   This test found and fixed a bug (first MQTT connection delayed 3 s).

Needs `g++` and OpenSSL headers (`libssl-dev`); ArduinoJson is taken from
`.pio/libdeps` or downloaded once. The full ESP32 build (`pio run`) needs internet
access to the PlatformIO registry.
