# Defence demo script (~15 minutes)

## Before the jury arrives (10 min)

```bash
docker compose --profile sim up -d            # platform + emulator (or real boards without --profile sim)
bash scripts/smoke-test.sh
npm run check -w @twin/calibration -- --commands   # all green
```
Open http://localhost:4000, log in as **admin**, pump running, twin in **monitoring**
(learned baseline). Keep a second terminal ready in the repository folder.
Have [results/evaluation.md](results/evaluation.md) open in a browser tab.

## Live part - narrated script

`npm run demo -w @twin/evaluation` runs every step below on Enter (`--auto` for a rehearsal).

| # | What happens | What to say (key points) | What the jury sees |
|---|--------------|--------------------------|--------------------|
| 1 | Normal operation | It is a twin, not a simulation: live mirror + learned physics + commands back + trust in data. The model was **identified from data** (pump curve, friction, outlet), not assumed. | schematic blue, residual bars near 0, "physics consistent" |
| 2 | Outlet valve to 55 % | Flow and pressure change a lot but mass is conserved: an **operating change is not an alarm** (common-mode flow change detected). | values move, no alert |
| 3 | Leak 0.5 L/min at 3.0 m | Mass balance from **pulse counters**, CUSUM, then the **hydraulic-gradient** formula locates it: position = fA·LA + fB·LB. The supervisor sends a **signed** stop command; the device acks; the effect is **verified** in telemetry. | segment B red, marker near 3 m, alert, pump OFF, command log "executed ✓ verified" |
| 4 | Repair + restart | Restart blocked by an **interlock**; admin override is **audited**. | 409 dialog → override, audit entry |
| 5 | Theft (valve opened over 10 s) | A theft is also a loss; the twin separates it by **behaviour** (onset rise time, recurrence). Honest limit: heuristic. | segment B purple, "Theft suspected" |
| 6 | Compromised node forges F1 +0.6 | Message is **correctly signed**: crypto cannot help. The **pump curve** says P1 does not match that flow → inconsistent, suspect **F1**. **No shutdown** on doubtful data, otherwise the attacker could use the twin to stop the pipeline (DoS through FDI). | "Measurements violate the physics - suspect F1", no pump stop |
| 7 | Network attacks | In the 2nd terminal: `npm run all -w @twin/attacks` → 24/24 defences held (TLS, ACL, HMAC, nonce, rate limit, RBAC, JWT). Audit log **hash chain verified**. | terminal summary, Security panel counters |

## Results part (slides from docs/results)

| Claim | Evidence |
|-------|----------|
| Detects leaks down to ~3 % of the flow in ~6 s, 100 % above 3 % | evaluation.md §1, detection-rate.svg |
| No false alarms in 6 h with 111 operating changes | evaluation.md §5 |
| Locates the leak: right segment 98 %, mean error 0.21 m on a 4 m pipe | evaluation.md §3 |
| Leak vs theft: 91 % (heuristic, limits stated) | evaluation.md §4 |
| FDI: 100 % detected, correct suspect, **0 % false shutdowns** vs 13-15 % for simple detectors | evaluation.md §6 |
| End-to-end through the real stack: detection, signed stop, verification in a few seconds | live-emulator.md |
| 24/24 attack scripts blocked | security-tests.json |
| Firmware conforms to the contract: 25 checks on the real `main.cpp`; C++ = TypeScript byte for byte | `npm run test:firmware` |

## Likely questions - short answers

- **Why a twin and not just thresholds?** Thresholds on raw flows miss leaks below ~10 % of the flow (B1 detects 40 % of our leaks) and cannot tell a leak from forged data. The twin's model gives expected values, hence residuals, localisation and consistency checks.
- **Why HMAC and not ECDSA?** Hardware-accelerated, simple, tiny; limit: no non-repudiation (the platform also holds the key). ECDSA is the documented upgrade.
- **What if an attacker forges all sensors consistently?** Not detectable from data alone - needs physical redundancy (a second independent measurement). Stated as a limit.
- **Why no remote calibration?** It would be a perfect false-data-injection channel; calibration requires physical USB access.
- **Clock attacks?** Messages must be within ±30 s of the platform clock; devices use NTP (a local NTP server removes the internet dependency).
- **Emulator vs reality?** The emulator was used to build before the hardware; the twin never depends on it. Its parameters can be re-identified from the real rig (`emulator-params`).
