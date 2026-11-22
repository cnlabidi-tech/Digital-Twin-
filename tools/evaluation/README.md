# tools/evaluation

Phase 9: metrics and defence demo. Results go to [docs/results](../../docs/results).

```bash
npm run offline -w @twin/evaluation              # Monte Carlo in virtual time (~90 s); --quick for a 15 s version
npm run live -w @twin/evaluation                 # end-to-end through the running stack + emulator (~12 min)
npm run live -w @twin/evaluation -- --mode manual  # same tests on the real rig, operator-driven
npm run demo -w @twin/evaluation                 # narrated defence demo (Enter between steps; --auto for rehearsal)
```

| File | Role |
|------|------|
| `sim.ts` | runs the emulator physics through the production twin code + plausibility checks, plus baselines B1/B2 |
| `offline.ts` | campaigns (leaks, thefts, normal hours, attacks), metrics, Markdown/JSON report, SVG figures |
| `live.ts` | timed scenarios through MQTT/TLS, database, alerts, signed commands and acknowledgements |
| `demo.ts` | the jury demo script (see docs/demo-script.md) |
