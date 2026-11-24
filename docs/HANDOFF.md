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

**2026-11-24:** every part now has a verified buy link (Algerian shops MHTronic,
Evolutronics, Atlas, Websoog, or AliExpress with the variant to pick) in the BOM of
docs/rig/index.html, prices in DZD; total about 62 000 DA. Decisions taken:
pressure sensor = XIDIBEI XDB401Pro "12V OUT 1-5V", 0-1 MPa (no firmware change);
PSU = closed 12 V 10 A adapter (MHTronic); MOSFET = dual D4184 module 15 A
(Evolutronics); hydraulics = one system of 1/2" BSP brass + 12 mm reinforced hose
(no PPR, no elbows). The two ESP32-S3 boards are already owned. Hose, PTFE, bucket,
containers, jug, base board and male hose barbs are cheaper in a local shop
(estimates in the table). Open points: ask the pump seller about its port type;
ask the sensor seller the minimum supply voltage of the 1-5 V variant.

Earlier review of ChatGPT's first list (kept for reference):

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

1. Student orders the parts from the BOM links (done: links + hose system in docs/rig/index.html).
2. Optional: republish the rig artifact so the online copy shows the links.
3. Pressure-sensor constants only change if a 5 V / 0.5-4.5 V sensor is bought instead.
4. When parts arrive: docs/integration-guide.md, then `npm run live -w @twin/evaluation -- --mode manual`.
5. Defence preparation: question-by-question review in Arabic (started with
   "twin vs simulation"; next: leak detection and why pulse counters are used).
