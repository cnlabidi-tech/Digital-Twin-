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
npm install
npm run setup -w @twin/security               # certificates, MQTT accounts, keys, users (printed once)
docker compose --profile sim up -d --build   # broker + DB + backend + emulator
docker compose ps                            # wait until all are up / healthy
bash scripts/smoke-test.sh                   # infrastructure checks (Git Bash / WSL on Windows)
curl http://localhost:4000/api/health        # ingestion counters
```

Stop: `docker compose down` - Wipe all data: `docker compose down -v`

| Service | Address | Notes |
|---------|---------|-------|
| MQTT broker | `mqtts://localhost:8883` | TLS + per-client accounts + ACL (`1883` only in dev mode) |
| TimescaleDB | `localhost:5432` | Credentials from `.env` |
| Dashboard + API | `http://localhost:4000` | Login with the accounts printed by the setup |
| Emulator control API | `http://localhost:4100/api/state` | Only with `--profile sim` |

For development without Docker for the Node services: `npm install`, then
`npm start -w @twin/backend`, `npm run emu` and `npm run dev -w @twin/dashboard`
(http://localhost:5173) in three terminals.

## Project phases

0. Repo, Docker Compose, architecture - **done**
1. Data contract + device emulator - **done** (see docs/data-contract.md, tools/emulator)
2. Ingestion + time-series storage - **done** (see services/backend)
3. Dashboard - **done** (http://localhost:5173 in dev, http://localhost:4000 in Docker)
4. Twin model + detection - **done** (see docs/twin-model.md)
5. Bidirectional control - **done** (see docs/control.md)
6. Security layer + attack scripts - **done** (see docs/security.md, `npm run all -w @twin/attacks`)
7. ESP32 firmware - **done** (see firmware/README.md, `npm run test:firmware`)
8. Hardware integration + calibration - **tools done, waiting for hardware** (see docs/integration-guide.md)
9. Results, metrics, demo script
