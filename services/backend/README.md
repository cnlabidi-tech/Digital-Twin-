# services/backend

**Phases 2, 4, 5, 6.** Node.js + TypeScript *modular monolith*:

- `ingestion/`  - MQTT subscriber, validation, write to TimescaleDB (Phase 2)
- `twin/`       - physical model of the pipe + detection (Phase 4)
- `control/`    - commands to devices + acknowledgements (Phase 5)
- `security/`   - signature/anti-replay checks, FDI detection, auth, audit (Phase 6)
- `api/`        - REST + WebSocket gateway for the dashboard
