# Pipeline Digital Twin

Digital twin of a small water-pipe prototype (stand-in for an oil/gas pipeline)
for **real-time leak and theft detection**, with a **cybersecurity layer**
against attacks such as false data injection.
Master 2 graduation project - IoT & Network Security.

See **[docs/architecture.md](docs/architecture.md)** for the full design and diagrams.

## Prerequisites

- Docker Desktop (or Docker Engine) with Docker Compose v2
- Node.js 20+ (needed from Phase 1)
- Git

## Quick start (Phase 0 - infrastructure)

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose up -d          # start Mosquitto + TimescaleDB
docker compose ps             # wait until both show "(healthy)"
bash scripts/smoke-test.sh    # automated checks (Git Bash / WSL on Windows)
```

Stop: `docker compose down` - Wipe all data: `docker compose down -v`

| Service | Address | Notes |
|---------|---------|-------|
| MQTT broker | `localhost:1883` | Dev only, anonymous; TLS + auth in Phase 6 |
| TimescaleDB | `localhost:5432` | Credentials from `.env` |

## Project phases

0. Repo, Docker Compose, architecture - **done**
1. Data contract + device emulator - **done** (see docs/data-contract.md, tools/emulator)
2. Ingestion + time-series storage
3. Dashboard
4. Twin model + detection
5. Bidirectional control
6. Security layer + attack scripts
7. ESP32 firmware
8. Hardware integration + calibration
9. Results, metrics, demo script
