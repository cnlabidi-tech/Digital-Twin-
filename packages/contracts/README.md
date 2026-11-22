# packages/contracts

**Phase 1.** Single source of truth for the data contract: MQTT topic names,
JSON Schemas and TypeScript types for telemetry, commands, acknowledgements and
events. Imported by the emulator, the backend and the dashboard so the three can
never drift apart. The ESP32 firmware (C++) follows the same schemas.
