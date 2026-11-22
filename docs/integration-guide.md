# Hardware integration and calibration guide (Phase 8)

Order matters: each step relies on the previous one. Tools: [`tools/calibration`](../tools/calibration).
Everything below was rehearsed against the emulator; with the real boards the
commands are identical.

## Step 0 - Prepare the PC

```bash
npm run setup -w @twin/security -- --san <PC LAN IP> --force    # certificate valid for the ESP32s
docker compose up -d --build                                     # platform WITHOUT the emulator profile
bash scripts/smoke-test.sh
```
Give the PC a fixed LAN IP (DHCP reservation) and allow TCP 8883 in its firewall.

## Step 1 - Bench test each board (no water)

1. Wire one board as in [hardware-wiring.md](hardware-wiring.md). Measure every divider
   output with 5 V at its input: **must be < 3.4 V** before connecting the ESP32.
2. Generate secrets and flash:
   ```bash
   npm run firmware-secrets -w @twin/security -- --ssid <wifi> --wifi-pass <pw> --broker <PC LAN IP>
   cd firmware && pio run -e inlet -t upload && pio device monitor
   ```
3. In the serial console: `status` -> wifi up, mqtt up, ntp synced, ads ok.
4. Repeat for the downstream board (`-e downstream`).

| Symptom | Likely cause |
|---------|--------------|
| `MQTT connect failed`, lastError -6/-7 | TLS: broker address not in certificate (redo step 0), or CA mismatch |
| returnCode 5 (not authorised) | wrong MQTT password: regenerate firmware secrets |
| ntp NOT synced | no internet: run an NTP server on the PC, or set `--ntp <PC IP>` |
| ads FAULT | I2C wiring (SDA 8, SCL 9), ADDR not to GND, ADS1115 not powered |
| pressure `out_of_range` | transducer not powered (12 V), divider open, signal wire broken |

## Step 2 - Bring-up check (both boards online)

```bash
npm run check -w @twin/calibration -- --seconds 20 --commands
```
Verifies: contract validity, telemetry rate, HMAC signatures, clock offset, sequence
numbers, sensor quality and ranges, pulse counters, Wi-Fi signal, pressure gradient,
flow-meter agreement, command round trip. Fix every FAIL before going on.

## Step 3 - Calibrate the sensors

All commands measure over MQTT and print the lines to type in the board's serial console
(calibration over the network is intentionally impossible).

| What | Condition | Command |
|------|-----------|---------|
| Divider ratio | multimeter on one divider: V in, V out | `npm run cal -w @twin/calibration -- divider --vin 4.998 --vout 3.326` |
| Pressure zero | pump OFF, pipe vented (0 bar) | `npm run cal -w @twin/calibration -- zero --device node-inlet --divider <ratio>` |
| Pressure span (optional) | pump ON, reference gauge at the sensor | `npm run cal -w @twin/calibration -- span --sensor P1 --reference 3.50 --offset <zero result>` |
| Flow K-factor | bucket test, >= 2 L, >= 30 s | `npm run cal -w @twin/calibration -- flow --device node-inlet --volume 2.0` |

Do the zero for both boards and the bucket test for both flow meters (F1 at the inlet,
F2 at the outlet, same volume). Expected after calibration: F1 and F2 within ~1 %.

## Step 4 - Topology

Measure the pipe length between sensors and edit `DEFAULT_TOPOLOGY.positionsM` in
[`packages/contracts/src/devices.ts`](../packages/contracts/src/devices.ts) (metres from P1).
Rebuild: `docker compose up -d --build`.

## Step 5 - Commission the twin

1. Start the pump from the dashboard (Control panel), wait until flows are steady.
2. Twin panel -> **Re-learn baseline** (admin). Keep the pipe healthy for 60 s.
3. Check the learned model:
   ```bash
   npm run check -w @twin/calibration -- --commands     # includes the twin commissioning checks
   ```
   It reports the identified resistances, flow-meter ratio, pump curve, noise, and the
   **fast detection limit** (smallest leak detected within ~3 s).
4. Optional: make the emulator reproduce the real rig:
   ```bash
   npm run cal -w @twin/calibration -- emulator-params
   ```

## Step 6 - Functional tests on the rig

| Test | Action | Expected |
|------|--------|----------|
| Valve change | close the outlet valve half-way | no alarm (operating change) |
| Leak A | open the leak valve in segment A quickly | leak alarm < 5 s, segment A, pump stopped |
| Leak B | same in segment B | segment B |
| Theft | open the theft branch valve slowly (~10 s) | theft alarm, segment B |
| Sensor unplugged | disconnect P3 signal | sensor fault alarm (`out_of_range`) |
| Board power loss | unplug ESP32 #2 | device offline alarm (last will) within ~15 s |
| Link loss fail-safe | stop the broker 2 min | inlet board stops the pump |

The guided version of these tests (with timing and metrics) is part of Phase 9.

## Validation of the tools on the emulator (known ground truth)

| Quantity | Identified | True (emulator) |
|----------|-----------|-----------------|
| F2 K-factor | 7.31 | 7.275 (7.5 x 0.97) |
| Pump shut-off / max flow | 7.96 bar / 4.99 L/min | 8 bar / 5 L/min |
| Pipe friction coefficient | 0.0203 | 0.020 |
| Outlet coefficient | 0.259 | 0.25 (x c² from flow-meter ratio) |
| Bring-up + commissioning checks | 30 pass, 0 fail | - |
