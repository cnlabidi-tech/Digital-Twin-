# Security layer (Phase 6)

Code: [`services/backend/src/security/`](../services/backend/src/security),
[`tools/security`](../tools/security) (setup), [`tools/attacks`](../tools/attacks) (demonstrations),
broker config [`infra/mosquitto/config/mosquitto.secure.conf`](../infra/mosquitto/config/mosquitto.secure.conf).

## 1. Threat model

| Attacker | Capability | Example |
|----------|-----------|---------|
| T1 Outsider on the network | sniff, inject packets, impersonate the broker | Wi-Fi neighbour, rogue access point |
| T2 Stolen device account | knows one ESP32's MQTT password | board stolen, flash dumped |
| T3 Compromised privileged account / broker | can publish on any topic | broker host compromised, admin password leaked |
| T4 Compromised device | controls a node's firmware **and its signing key** | malicious firmware, tampered sensor wiring |
| T5 Web attacker / insider | uses the dashboard / API | curious viewer, password guessing |

## 2. Defences (defence in depth)

```mermaid
flowchart LR
    D[ESP32] -- "TLS 1.2+ (T1)" --> B[Mosquitto<br/>auth + ACL (T1,T2)]
    B --> G[Security gate<br/>HMAC, ts, nonce, seq, rate (T3)]
    G --> S[Schema + semantic validation]
    S --> P[Plausibility checks<br/>frozen, replayed, jumps, raw/value (T4)]
    S --> T[Twin physics consistency<br/>signature matrix (T4)]
    P & T --> A[Alerts + interlocks<br/>no auto action on doubtful data]
    W[Browser] -- "login, JWT, roles (T5)" --> API --> AU[(Hash-chained audit log)]
```

| Layer | Mechanism | Stops | Where |
|-------|-----------|-------|-------|
| Transport | TLS 1.2+, server cert from project CA, hostname check, no plain listener | T1 sniffing, MITM, broker impersonation | broker, all clients |
| Broker identity | one account per client, PBKDF2-SHA512 hashed passwords, no anonymous, client id = username | T1, session hijack by id | `mosquitto/passwd` |
| Broker authorisation | ACL: device X writes only `pipeline/v1/X/{telemetry,status,ack}`, reads only `pipeline/v1/X/cmd`; only `backend` writes commands | T2 topic spoofing, spying, forged commands | `mosquitto/acl` |
| Message integrity | HMAC-SHA256 per device over the exact JSON bytes; constant-time compare | T3 forged / tampered messages and commands | backend gate, device |
| Freshness | `|now - ts| <= 30 s` (NTP on devices) | T3 delayed replay | backend gate, device |
| Anti-replay | nonce cache (60 s) + strictly increasing `seq` per boot | T3 immediate replay | backend gate, device (nonces) |
| Rate limit | 20 authentic msg/s/device, counted after the signature check | T4 flooding; forged floods cannot starve real data | backend gate |
| Plausibility | frozen value, replayed sequence, impossible jump, value vs raw (ADC/pulses) | T4 simple FDI | `security/plausibility.ts` |
| Physics | 6 residuals, consistency diagnosis, suspect isolation | T4 stealthy FDI | `twin/diagnosis.ts` |
| Safe automation | no automatic shutdown while integrity is in doubt | T4 DoS through FDI | `control/supervisor.ts` |
| Users | scrypt passwords, JWT (8 h), roles viewer/operator/admin, lock-out after 5 failures | T5 | `security/auth.ts` |
| Accountability | append-only audit log (DB trigger) + SHA-256 hash chain, verify endpoint | T5 insider, log tampering | `security/audit.ts` |

Signed bytes: see [data-contract.md](data-contract.md) section 3. The **device**
performs the same checks on commands (signature, device id, freshness, nonce),
so even a fully compromised broker cannot drive the pump.

## 3. Setup

```bash
npm run setup -w @twin/security -- --san <LAN IP of this PC>   # once
docker compose --profile sim up -d --build
```

Creates `secrets/` (git-ignored): CA, broker certificate, MQTT accounts and
ACL, device HMAC keys, env files, initial dashboard passwords (printed once).
`SECURITY_MODE=dev` in `.env` switches back to plain MQTT without login (debug only).

> Lab notes: the `redteam` broker account exists only to demonstrate layers
> behind the broker (create secrets with `--no-redteam` for a real system).
> Secret files are readable by the containers' user; production would use
> Docker secrets / a vault and, on the ESP32-S3, keys burnt into eFuse used by
> the HMAC peripheral (the key never leaves the chip).

## 4. Attack demonstrations

`npm run all -w @twin/attacks` (needs the stack and the emulator; `--slow` adds
the 35-second freshness tests). Each script prints DEFENCE HELD / FAILED with
evidence; results go to `docs/results/security-tests.json`.

| Script | Attack | Attacker | Expected defence | Result |
|--------|--------|----------|------------------|--------|
| a1 | plain-text connect, MITM certificate, spoofed hostname | T1 | TLS + CA + SAN | held |
| a2 | anonymous, guessed / reused passwords | T1 | broker auth | held |
| a3 | stolen device account publishes as another node / sends commands / spies | T2 | ACL | held |
| a4 | unsigned, wrongly-signed and replayed commands to the pump | T3 | device-side HMAC + nonce | held |
| a5 | fabricated, tampered and replayed telemetry | T3 | backend gate | held |
| a6 | 400-message flood | T3/T4 | signature first, rate limit | held, genuine data unaffected |
| a7 | FDI: fake leak (F1+0.6), replay to hide a real leak, frozen P1 | T4 | physics + plausibility, no auto-stop | held (alarms in 4-10 s) |
| a8 | no token, viewer command, forged JWT role, brute force, WebSocket without token | T5 | JWT, RBAC, lock-out | held |

## 5. Limits (to discuss in the thesis)

- A compromised device that forges **all** its sensors consistently with the
  physics of the other device's honest sensors is not detectable from data alone
  (needs redundancy: more sensors, or a second, independent measurement chain).
- A stolen device account can take over the device's broker session (the real
  node is disconnected). This is visible (device offline alert) but not prevented;
  client certificates (mutual TLS) would bind the account to the hardware.
- Symmetric HMAC keys: the platform can also produce device signatures
  (no non-repudiation). ECDSA would fix it at a higher cost on the ESP32.
- JWT in localStorage is readable by injected scripts (XSS); the dashboard has no
  user-generated HTML, but HttpOnly cookies would be stronger.
