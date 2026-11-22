# tools/emulator

Development tool that behaves **exactly like ESP32 #1 and ESP32 #2 on the wire**
(same topics, payloads, signing, command checks, acks, last will), driven by a
hydraulic model of the rig. Replaced by the real boards in Phase 8; the
platform cannot tell the difference.

```
plant.ts           physics: pump curve, friction, valves, taps, first-order dynamics,
                   sensor electronics (ADS1115 counts, YF-S201 pulses, noise, calibration errors)
hydraulics.ts      steady-state network solver (bisection on pump flow)
firmware-logic.ts  conversions the real firmware will do (counts->bar, pulses->L/min)
device.ts          one emulated ESP32: MQTT, telemetry, status/LWT, commands + security checks, acks
attacks.ts         false data injection (compromised device) and network attacks (outsider)
emulator.ts        orchestrator + ground-truth log
api.ts             HTTP control API (localhost:4100)
scenario.ts        timed scenarios from JSON files (scenarios/)
monitor.ts         validates and prints all traffic (works with real boards too)
```

## Run

```bash
docker compose up -d                       # broker must be running
npm start -w @twin/emulator                # two devices publishing
npm run monitor -w @twin/emulator          # in a 2nd terminal: watch + validate traffic
npm run scenario -w @twin/emulator -- scenarios/leak-segment-a.json --truth-log truth.jsonl
```

## Inject (control API)

```bash
curl -X POST localhost:4100/api/leak   -d '{"segment":"A","fraction":0.5,"rateLpm":0.5}'
curl -X POST localhost:4100/api/theft  -d '{"segment":"B","rateLpm":0.9,"rampS":10}'
curl -X POST localhost:4100/api/valve  -d '{"outletOpening":0.6}'
curl -X POST localhost:4100/api/faults -d '{"sensor":"P2","type":"stuck"}'
curl -X POST localhost:4100/api/attacks -d '{"type":"fdi_bias","sensor":"F1","delta":0.6}'
curl -X POST localhost:4100/api/attacks -d '{"type":"fdi_replay","device":"node-downstream","recordS":20}'
curl -X POST localhost:4100/api/attacks -d '{"type":"replay","device":"node-downstream"}'
curl -X POST localhost:4100/api/devices/node-downstream/offline -d '{"seconds":20}'
curl localhost:4100/api/state
curl -X POST localhost:4100/api/reset
```

| Injection | Options |
|-----------|---------|
| leak / theft | `segment` A or B, `fraction` 0..1 inside the segment, `rateLpm` (flow at 3 bar), `rampS` (leak default 0 = burst; theft default 8 s = valve turned by hand) |
| valve | `outletOpening` 0.05..1 - a normal operating change, must NOT raise an alarm |
| faults | `stuck`, `disconnected` (all sensors); `drift` (bar/min), `noisy` (pressure only) |
| FDI attacks (signed, fresh: crypto cannot see them) | `fdi_bias` delta, `fdi_scale` factor, `fdi_freeze`, `fdi_ramp` ratePerS, `fdi_replay` recordS; `naive:true` leaves `raw` inconsistent |
| network attacks | `tamper` (breaks signature), `replay` (old messages), `spoof` (outsider, wrong key), `drop` |
