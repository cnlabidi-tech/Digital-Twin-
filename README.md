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

## Quick start

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose --profile sim up -d --build   # broker + DB + backend + emulator
docker compose ps                            # wait until all are up / healthy
bash scripts/smoke-test.sh                   # infrastructure checks (Git Bash / WSL on Windows)
curl http://localhost:4000/api/health        # ingestion counters
```

Stop: `docker compose down` - Wipe all data: `docker compose down -v`

| Service | Address | Notes |
|---------|---------|-------|
| MQTT broker | `localhost:1883` | Dev only, anonymous; TLS + auth in Phase 6 |
| TimescaleDB | `localhost:5432` | Credentials from `.env` |
| Backend API | `http://localhost:4000/api/health` | REST (WebSocket in Phase 3) |
| Emulator control API | `http://localhost:4100/api/state` | Only with `--profile sim` |

For development without Docker for the Node services: `npm install`, then
`npm start -w @twin/backend` and `npm run emu` in two terminals.

## Project phases

0. Repo, Docker Compose, architecture - **done**
1. Data contract + device emulator - **done** (see docs/data-contract.md, tools/emulator)
2. Ingestion + time-series storage - **done** (see services/backend)
3. Dashboard
4. Twin model + detection
5. Bidirectional control
6. Security layer + attack scripts
7. ESP32 firmware
8. Hardware integration + calibration
9. Results, metrics, demo script
