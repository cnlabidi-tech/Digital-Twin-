# tools/attacks

Attack demonstrations against **our own lab platform** (localhost). Each script
plays one attacker and prints `DEFENCE HELD` / `DEFENCE FAILED` with evidence.
See [docs/security.md](../../docs/security.md) for the threat model.

```bash
npm run all -w @twin/attacks          # everything (~3 min), writes docs/results/security-tests.json
npm run all -w @twin/attacks -- --slow  # + 35-second freshness tests
npm run a4 -w @twin/attacks           # one script
```

| Script | Attacker | Attack |
|--------|----------|--------|
| a1 | outsider on the network | plain-text MQTT, MITM certificate, spoofed broker name |
| a2 | outsider | anonymous / guessed / reused passwords |
| a3 | stolen device account | publish as another node, command the pump, spy |
| a4 | privileged broker account (`redteam`) | unsigned, wrongly signed, replayed commands |
| a5 | privileged broker account | fabricated, tampered, replayed telemetry |
| a6 | privileged broker account | 400-message flood |
| a7 | compromised device (signs correctly) | fake leak, replay to hide a real leak, frozen sensor (needs the emulator) |
| a8 | web attacker / insider | no token, wrong role, forged JWT, brute force, WebSocket |

Requirements: stack running in secure mode, emulator running (`--profile sim`),
secrets from `npm run setup -w @twin/security` (with the default lab `redteam` account).
Note: a8 locks the `operator` account for 5 minutes (brute-force test).
