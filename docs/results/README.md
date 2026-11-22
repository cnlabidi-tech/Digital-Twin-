# Results (Phase 9)

All numbers are reproducible with the commands below. Files in this folder are
generated, never edited by hand.

| File | Produced by | Content |
|------|-------------|---------|
| [evaluation.md](evaluation.md) / `.json` | `npm run offline -w @twin/evaluation` (~90 s, seed 7) | Monte-Carlo campaign in virtual time: 400 leaks, 100 thefts, 6 h normal operation, 108 attack/fault scenarios; twin vs two baselines |
| [detection-rate.svg](detection-rate.svg), [detection-delay.svg](detection-delay.svg) | same | thesis figures |
| [live-emulator.md](live-emulator.md) / `.json` | `npm run live -w @twin/evaluation` (stack + emulator, ~12 min) | end-to-end through MQTT/TLS, database, alerts, signed commands, acknowledgements |
| `live-manual.md` | `npm run live -w @twin/evaluation -- --mode manual` | the same tests on the real rig (operator performs the actions) |
| [security-tests.json](security-tests.json) | `npm run all -w @twin/attacks` | 24 attack scripts against the live stack |

## Headline numbers (emulator physics)

| Property | Result | Baselines |
|----------|--------|-----------|
| Leak detection rate (0.05-1.2 L/min, random position / operating point) | **97 %** | naive mass balance 40 %, threshold-only 64 % |
| Smallest leaks (< 0.09 L/min, ~1.7 % of flow) | 80 % detected, median 12.5 s | 0 % |
| Leaks >= ~3 % of flow | 100 %, median 3-6 s | |
| False leak alarms in normal operation (6 h, 111 operating changes) | **0 / h** | 0 / h |
| False data-integrity alarms in normal operation | **0 / h** | - |
| Segment localisation | **98 %** correct, mean error 0.21 m (p95 0.78 m) on 4 m | - |
| Leak vs theft classification | 91 % | - |
| FDI / sensor faults detected | **100 %**, attacked sensor among suspects 100 % | - |
| False leak alarms caused by attacks | **0 %** | 13-15 % |
| False automatic shutdowns caused by attacks (DoS) | **0 %** | 13-15 % |
| Real leaks misdiagnosed as attacks | 0 / 500 | - |
| End-to-end live tests | **10/10**, detection ~3-5 s, verified pump stop ~7-8 s (leak) | - |
| Attack scripts | **24/24** defences held | - |
| Firmware | 29/29 cross-language vectors, 25/25 conformance checks | - |

## How the evaluation is built

- The emulator physics (pump curve, friction, outlet valve, leaks as orifices,
  sensor noise, ADC quantisation, YF-S201 pulse quantisation and K-factor error)
  runs in virtual time through the **production** twin code (TwinCore and the
  plausibility checks): no re-implementation for the evaluation.
- The twin model is learned once (commissioning), then every scenario starts at
  a random operating point (outlet 60-100 %, pump 80-100 %).
- Ground truth is known exactly, so detection, delay, localisation error and
  classification are measured, not estimated.
- Fixed random seed: the same command gives the same tables.

## Limits of these numbers

- They come from a physical model of the rig, not the rig itself: the real-rig
  values come from `live --mode manual` after calibration (Phase 8).
- Leak vs theft relies on a behavioural heuristic (onset rise time, recurrence);
  a slowly growing crack or a thief opening a valve quickly would be misclassified.
- An attacker who forges all sensors consistently with the physics is out of
  reach of any data-only method (stated in docs/security.md).
