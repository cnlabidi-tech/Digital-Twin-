/**
 * Emulator entry point.
 *
 *   npm start -w @twin/emulator -- [options]
 *
 *   --mqtt <url>         broker URL            (env MQTT_URL, default mqtt://localhost:1883)
 *   --interval <ms>      telemetry period      (default 500)
 *   --api-port <port>    control API port      (env EMU_API_PORT, default 4100)
 *   --api-host <host>    control API bind      (env EMU_API_HOST, default 127.0.0.1)
 *   --scenario <file>    run a scenario file, exit when it ends (if durationS is set)
 *   --truth-log <file>   append ground-truth events (JSON lines)
 *   --keys <file>        JSON {"node-inlet":"<hex>", ...} per-device HMAC keys (Phase 6)
 *   --quiet              less logging
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEVICE_IDS, type DeviceId } from '@twin/contracts';
import { startApi } from './api';
import { Emulator } from './emulator';
import { loadScenario, runScenario } from './scenario';

const { values: a } = parseArgs({
  options: {
    mqtt: { type: 'string' },
    interval: { type: 'string' },
    'api-port': { type: 'string' },
    'api-host': { type: 'string' },
    scenario: { type: 'string' },
    'truth-log': { type: 'string' },
    keys: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});

const env = process.env;
const mqttUrl = a.mqtt ?? env.MQTT_URL ?? 'mqtt://localhost:1883';
const keysPath = a.keys ?? env.EMU_KEYS_FILE;
const keys: Partial<Record<DeviceId, string>> = keysPath && existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, 'utf8')) : {};

const device = Object.fromEntries(
  DEVICE_IDS.map((id) => {
    const envKey = id.toUpperCase().replace('-', '_'); // NODE_INLET
    return [id, {
      keyHex: keys[id],
      requireSignedCommands: Boolean(keys[id]),
      username: env[`MQTT_USER_${envKey}`],
      password: env[`MQTT_PASS_${envKey}`],
    }];
  }),
);

const emu = new Emulator({
  mqttUrl,
  intervalMs: Number(a.interval ?? 500),
  truthLog: a['truth-log'] ?? env.EMU_TRUTH_LOG,
  ca: env.MQTT_CA_FILE ? readFileSync(env.MQTT_CA_FILE) : undefined,
  device,
  quiet: a.quiet,
});

console.log(`[emulator] broker ${mqttUrl}, signing: ${Object.keys(keys).length ? 'ON' : 'OFF (no keys file)'}`);
emu.start();
const api = startApi(emu, Number(a['api-port'] ?? env.EMU_API_PORT ?? 4100), a['api-host'] ?? env.EMU_API_HOST ?? '127.0.0.1');

const shutdown = async () => {
  console.log('[emulator] shutting down');
  api.close();
  await emu.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (a.scenario) {
  // give the devices a few seconds to connect and the plant to settle
  setTimeout(() => runScenario(emu, loadScenario(a.scenario!), shutdown), 3000);
}
