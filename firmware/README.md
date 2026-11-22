# firmware

**Phase 7.** PlatformIO projects (Arduino framework) for the two ESP32-S3 boards:

- `inlet-node/`      - ESP32 #1: pump control (D4184), P1, F1
- `downstream-node/` - ESP32 #2: P2 (mid-line), P3 + F2 (outlet)
- `common/`          - shared library: MQTT/TLS, signing, time sync, calibration
