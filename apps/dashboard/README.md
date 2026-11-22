# apps/dashboard

React 19 + Vite single-page app. Live data over one WebSocket (`/ws`),
history and actions over REST (`/api/...`).

| Component | Role |
|-----------|------|
| `PipelineSchematic` | SVG twin of the rig: pump, segments A/B coloured by state, live sensor values, flow animation, estimated leak position, ΔQ |
| `LiveCharts` + `Chart` | uPlot canvas charts: live rolling window (1-30 min) or history from TimescaleDB (1 h - 7 d) |
| `AlertsPanel` | open alerts, most severe first, acknowledge |
| `EventHistory` | timeline of device / security / alert / command / system events |
| `SimPanel` | **emulator only**: inject leaks, theft, faults, attacks; hidden when no emulator runs |
| `lib/store.ts` | WebSocket client, reconnect, ring buffers, `useLive()` hook (renders at most once per frame) |

## Run

```bash
npm run dev -w @twin/dashboard     # http://localhost:5173 (proxies /api and /ws to :4000)
npm run build -w @twin/dashboard   # production build, served by the backend at http://localhost:4000
```
