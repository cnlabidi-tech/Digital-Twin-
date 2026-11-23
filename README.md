# Pipeline Digital Twin

Digital twin of a small water-pipe prototype (stand-in for an oil/gas pipeline)
for **real-time leak and theft detection**, with a **cybersecurity layer**
against attacks such as false data injection.
Master 2 graduation project - IoT & Network Security.

See **[docs/architecture.md](docs/architecture.md)** for the full design and diagrams.

## Prerequisites

- Docker Desktop (or Docker Engine) with Docker Compose v2
- Node.js 20+ (22 recommended)
- Git
- For the firmware: PlatformIO (VS Code extension or `pip install platformio`); for host firmware tests: g++ and OpenSSL headers

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
9. Results, metrics, demo script - **done** (see docs/results/README.md, docs/demo-script.md)

## Headline results (emulator physics, see docs/results)

- Leak detection **97 %** (naive mass balance 40 %), 100 % above ~3 % of the flow, median 3-6 s
- **0** false alarms in 6 h of normal operation with 111 operating changes
- Right segment **98 %**, mean position error 0.21 m on a 4 m pipe; leak vs theft 91 %
- False data injection detected **100 %**, **0 %** false automatic shutdowns (simple detectors: 13-15 %)
- Live end-to-end tests 10/10; attack scripts **24/24** blocked

## Useful commands

| Command | What |
|---------|------|
| `npm test` / `npm run typecheck` | unit and scenario tests / type checking of every workspace |
| `npm run test:firmware` | firmware host tests (C++ vs TypeScript vectors, conformance of the real main.cpp) |
| `npm run all -w @twin/attacks` | 24 attack demonstrations against the live stack |
| `npm run check -w @twin/calibration -- --commands` | bring-up / commissioning report (real boards or emulator) |
| `npm run offline -w @twin/evaluation` | Monte-Carlo evaluation -> docs/results/evaluation.md |
| `npm run live -w @twin/evaluation` | end-to-end evaluation through the running stack |
| `npm run demo -w @twin/evaluation` | narrated defence demo (Enter between steps) |

## Documentation

| Document | Content |
|----------|---------|
| [architecture.md](docs/architecture.md) | design, diagrams, technology choices |
| [data-contract.md](docs/data-contract.md) | MQTT topics, JSON payloads, signing |
| [twin-model.md](docs/twin-model.md) | physics model, residuals, detection, diagnosis, localisation |
| [control.md](docs/control.md) | commands, acknowledgements, automatic actions, interlocks |
| [security.md](docs/security.md) | threat model, defences, attack scripts, limits |
| [hardware-wiring.md](docs/hardware-wiring.md) / [integration-guide.md](docs/integration-guide.md) | wiring, bring-up, calibration |
| [results/README.md](docs/results/README.md) / [demo-script.md](docs/demo-script.md) | metrics, defence demo |
| [rig/index.html](docs/rig/index.html) | interactive 3D model of the physical rig + bill of materials (open in a browser) |
