/**
 * Firmware conformance test: compiles the REAL firmware (src/main.cpp + lib/twin)
 * for both roles against simulated hardware (stubs/), runs it, sends it signed /
 * tampered / unsigned / replayed commands, and checks EVERY published message
 * with the platform's own validators and signature verification.
 *
 *   npx tsx firmware/test/host/conformance.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { newCmdId, newNonce, validateAck, validateStatus, validateTelemetry, type Telemetry } from '../../../packages/contracts/src/index';
import { signMessage, verifyMessage } from '../../../packages/contracts/src/signing';

const HERE = import.meta.dirname;
const FW = resolve(HERE, '../..');
const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const OUT = '/tmp/twin-fw-conformance';
mkdirSync(OUT, { recursive: true });

// ArduinoJson: use the copy PlatformIO downloaded, else fetch the single header once.
function arduinoJsonDir(): string {
  for (const env of ['inlet', 'downstream']) {
    const d = resolve(FW, `.pio/libdeps/${env}/ArduinoJson/src`);
    if (existsSync(resolve(d, 'ArduinoJson.h'))) return d;
  }
  const cache = resolve(HERE, '.cache');
  if (!existsSync(resolve(cache, 'ArduinoJson.h'))) {
    mkdirSync(cache, { recursive: true });
    execFileSync('curl', ['-sSfL', '-o', resolve(cache, 'ArduinoJson.h'), 'https://github.com/bblanchon/ArduinoJson/releases/download/v7.2.1/ArduinoJson-v7.2.1.h']);
  }
  return cache;
}

let checks = 0;
let failures = 0;
const check = (ok: boolean, msg: string) => {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

function build(role: 'NODE_INLET' | 'NODE_DOWNSTREAM'): string {
  const bin = resolve(OUT, role.toLowerCase());
  execFileSync('g++', [
    '-std=gnu++17', '-O1', '-w', `-D${role}`, '-DTWIN_HOST', '-DSECRETS_FILE="secrets_test.h"',
    '-DARDUINOJSON_ENABLE_PROGMEM=0', '-DARDUINOJSON_ENABLE_ARDUINO_STREAM=0', '-DARDUINOJSON_ENABLE_ARDUINO_PRINT=0', '-DARDUINOJSON_ENABLE_ARDUINO_STRING=1',
    `-I${resolve(HERE, 'stubs')}`, `-I${arduinoJsonDir()}`, `-I${resolve(FW, 'include')}`, `-I${resolve(FW, 'lib/twin/src')}`,
    resolve(FW, 'src/main.cpp'), resolve(FW, 'lib/twin/src/twin_crypto.cpp'), resolve(FW, 'lib/twin/src/twin_protocol.cpp'),
    resolve(FW, 'lib/twin/src/twin_sensors.cpp'), resolve(FW, 'lib/twin/src/twin_calib.cpp'),
    resolve(HERE, 'stubs/sim.cpp'), resolve(HERE, 'stubs/harness.cpp'), '-lcrypto', '-o', bin,
  ], { stdio: 'inherit' });
  return bin;
}

function run(bin: string, cmds: string[]) {
  const out = execFileSync(bin, cmds, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pubs = out.split('\n').filter((l) => l.startsWith('PUB ')).map((l) => {
    const [, topic, ...rest] = l.split(' ');
    return { topic: topic!, payload: rest.join(' ') };
  });
  const will = out.split('\n').find((l) => l.startsWith('WILL '));
  return { pubs, will: will?.split(' ').slice(2).join(' ') };
}

const cmd = (deviceId: string, type: string, params: object) => ({ v: 1, cmdId: newCmdId(), deviceId, ts: Date.now(), nonce: newNonce(), issuedBy: 'user:test', type, params });

function checkCommon(device: string, pubs: Array<{ topic: string; payload: string }>, will?: string) {
  const status = pubs.filter((p) => p.topic.endsWith('/status'));
  const tel = pubs.filter((p) => p.topic.endsWith('/telemetry'));
  check(!!will && validateStatus(JSON.parse(will)).ok, `${device}: last-will message conforms to the Status schema`);
  check(status.length === 1 && validateStatus(JSON.parse(status[0]!.payload)).ok, `${device}: retained "online" status published once and conforms`);
  check(status.length > 0 && status.every((s) => verifyMessage(s.payload, KEY).ok), `${device}: status signature verifies with the platform code`);
  check(tel.length >= 5, `${device}: telemetry published every 500 ms (${tel.length} messages)`);
  const bad = tel.map((t) => validateTelemetry(JSON.parse(t.payload))).filter((v) => !v.ok);
  check(bad.length === 0, `${device}: all telemetry passes schema + semantic validation${bad.length ? ` (${JSON.stringify(bad[0])})` : ''}`);
  check(tel.length > 0 && tel.every((t) => verifyMessage(t.payload, KEY).ok), `${device}: all telemetry signatures verify (exact-bytes HMAC)`);
  const seqs = tel.map((t) => (JSON.parse(t.payload) as Telemetry).seq);
  check(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1), `${device}: sequence numbers strictly increasing`);
  const nonces = new Set(tel.map((t) => (JSON.parse(t.payload) as Telemetry).nonce));
  check(nonces.size === tel.length, `${device}: every message has a fresh nonce`);
  return tel.map((t) => JSON.parse(t.payload) as Telemetry);
}

// ------------------------------------------------------------- inlet
console.log('Building and running node-inlet firmware (host simulation)...');
const inlet = build('NODE_INLET');
const good = signMessage(cmd('node-inlet', 'pump.set', { on: true, duty: 80 }), KEY);
const tampered = signMessage(cmd('node-inlet', 'pump.set', { on: false }), KEY).replace('"on":false', '"on":true ');
const unsigned = JSON.stringify(cmd('node-inlet', 'pump.set', { on: false }));
const ping = signMessage(cmd('node-inlet', 'ping', {}), KEY);
const stale = signMessage({ ...cmd('node-inlet', 'ping', {}), ts: Date.now() - 120_000 }, KEY);
const r1 = run(inlet, [good, tampered, unsigned, good, stale, ping]);
const telIn = checkCommon('node-inlet', r1.pubs, r1.will);
const acks = r1.pubs.filter((p) => p.topic.endsWith('/ack')).map((p) => p.payload);
check(acks.length === 6 && acks.every((a) => validateAck(JSON.parse(a)).ok && verifyMessage(a, KEY).ok), 'node-inlet: 6 acks, all valid and signed');
const outcome = acks.map((a) => { const j = JSON.parse(a); return j.status === 'executed' ? 'executed' : j.reason; });
check(JSON.stringify(outcome) === JSON.stringify(['executed', 'bad_signature', 'missing_signature', 'replayed_nonce', 'stale_timestamp', 'executed']),
  `node-inlet: command outcomes = ${outcome.join(', ')}`);
const last = telIn[telIn.length - 1]!;
check(last.actuators?.pump.on === true && last.actuators.pump.duty === 80, 'node-inlet: pump state in telemetry follows the executed command (on, 80 %)');
check(Math.abs((last.sensors.P1?.v ?? 0) - 4.1) < 0.02, `node-inlet: P1 conversion ${last.sensors.P1?.v} bar (simulated 4.10)`);
check(Math.abs((last.sensors.F1?.v ?? 0) - 3.467) < 0.3, `node-inlet: F1 from pulses ${last.sensors.F1?.v} L/min (simulated 3.47)`);

// ------------------------------------------------------------- downstream
console.log('Building and running node-downstream firmware (host simulation)...');
const down = build('NODE_DOWNSTREAM');
const r2 = run(down, [signMessage(cmd('node-downstream', 'pump.set', { on: false }), KEY), signMessage(cmd('node-downstream', 'telemetry.set_interval', { intervalMs: 1000 }), KEY), signMessage(cmd('node-inlet', 'ping', {}), KEY)]);
const telDown = checkCommon('node-downstream', r2.pubs, r2.will);
const acks2 = r2.pubs.filter((p) => p.topic.endsWith('/ack')).map((p) => JSON.parse(p.payload) as { status: string; reason?: string });
check(acks2[0]?.reason === 'not_supported', 'node-downstream: pump command refused (not_supported)');
check(acks2[1]?.status === 'executed', 'node-downstream: telemetry.set_interval executed');
check(acks2[2]?.reason === 'wrong_device', 'node-downstream: command addressed to node-inlet refused (wrong_device)');
const l2 = telDown[telDown.length - 1]!;
check(l2.intervalMs === 1000 && Math.abs((l2.sensors.P3?.v ?? 0) - 3.6) < 0.02, `node-downstream: interval now ${l2.intervalMs} ms, P3 ${l2.sensors.P3?.v} bar (simulated 3.60)`);

console.log(`\n${checks - failures}/${checks} conformance checks passed`);
process.exit(failures ? 1 : 0);
