# tools/security

One-time generation of all lab secrets into `./secrets` (git-ignored).

```bash
npm run setup -w @twin/security -- --san 192.168.1.50   # LAN IP the ESP32s use
npm run setup -w @twin/security -- --force               # regenerate (devices must be re-flashed)
npm run setup -w @twin/security -- --no-redteam          # without the attack-demo account
```

| File | Purpose |
|------|---------|
| `ca.crt`, `ca.key` | project Certificate Authority (RSA 2048, 10 years) |
| `server.crt`, `server.key` | broker certificate (SAN: localhost, mosquitto, 127.0.0.1, --san ...) |
| `mosquitto/passwd`, `mosquitto/acl` | hashed MQTT passwords (PBKDF2-SHA512, mosquitto `$7$` format) and topic ACLs |
| `mqtt-credentials.json` | plaintext MQTT passwords (for firmware / emulator configuration) |
| `device-keys.json` | per-device HMAC-SHA256 keys (32 bytes) |
| `backend.env`, `emulator.env` | environment for docker-compose |
| `initial-users.json` | first dashboard passwords (admin, operator, viewer) |
