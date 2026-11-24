# Handoff - where the project stands

Read this first when continuing the work in a new session (for example a local
session on the student's own computer).

## Working agreement with the student

- Master 2 project (IoT & Network Security): digital twin of a water-pipe rig for
  leak/theft detection with a security layer. The assistant writes the code; the
  student reviews, tests and must understand everything for the defence.
- Talk to the student **in Arabic**. Format: each item on its own line, starting with
  the English term in **bold**, then a colon, then a short Arabic explanation. No
  English words in the middle of Arabic sentences (they render broken).
- Work on branch `claude/water-pipe-digital-twin-e4qm97`, one commit per step.

## Done (phases 0-9)

All software is finished and pushed; see README.md and docs/:
architecture, data contract, emulator, ingestion + TimescaleDB, React dashboard,
twin model + detection (docs/twin-model.md), control (docs/control.md), security +
24 attack scripts (docs/security.md), ESP32 firmware with host tests
(firmware/README.md), calibration tools (docs/integration-guide.md), evaluation
and defence demo (docs/results/README.md, docs/demo-script.md).
The student ran it successfully on a friend's PC with the emulator.

Extra: docs/rig/index.html = interactive 3D model of the physical rig (U-shaped,
2 m per segment) + bill of materials, published as a private artifact.

## In progress: buying the parts (nothing bought yet)

The student asked ChatGPT to find the parts and showed product photos. Review result:

- OK: ESP32-S3-DevKitC-1 N8R8 x2, ADS1115 x2, YF-S201 x2, pump 12 V 60 W 0.8 MPa
  5 L/min, D4184, LM2596 x2 (set to 5 V BEFORE connecting), resistor kit (has 10k/20k),
  brass tees 1/2" x6, bucket with lid, inlet strainer.
- To confirm: pressure transducer variant (12 V / 1-5 V expected by the firmware;
  if it is 5 V / 0.5-4.5 V, change `PressureElec` in firmware/lib/twin/src/twin_sensors.h,
  `PRESSURE_ELEC` in tools/emulator/src/plant.ts and the constants in
  services/backend/src/security/plausibility.ts), range 0-10 bar, thread G1/4 BSP;
  power supply >= 12 V 6 A (closed adapter preferred); ball valves must be 1/2" not 1".
- To change: PPR pipe -> reinforced hose 1/2" ID >= 10 bar (PPR needs heat welding);
  the barb kit is 1/4" (too small) -> 1/2" BSP male x 1/2" barb x20; project boxes
  must be IP65 with gasket + PG7 glands; drop PVC elbows; SS34 -> 1N5822 (through-hole);
  fuse 7.5 A.
- Missing: hex nipples 1/2" x5, female 1/2" x barb adapters x4 (YF-S201), hose 6 m,
  ~30 clamps, cable glands, USB-C data cables, wiring set, multimeter, 2 L jug,
  drip trays, 5 L container, base board.
- A complete English prompt for ChatGPT with all these specs was given to the student.

## Next steps

1. Review ChatGPT's product links/specs when the student pastes them.
2. If agreed, update docs/rig/index.html (hose system, fittings plan, quantities).
3. Adapt pressure-sensor constants if the 5 V variant is chosen.
4. When parts arrive: docs/integration-guide.md, then `npm run live -w @twin/evaluation -- --mode manual`.
5. Defence preparation: question-by-question review in Arabic (started with
   "twin vs simulation"; next: leak detection and why pulse counters are used).
