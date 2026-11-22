/**
 * Contract monitor: subscribes to the whole topic tree, validates every
 * message against the data contract and prints a compact line per message.
 * Works identically with the emulator and with the real ESP32s, so it is also
 * the first test tool in Phase 8.
 *
 *   npm run monitor -w @twin/emulator -- [--mqtt url] [--keys file] [--raw]
 */
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';
import {
  parseJson, parseTopic, TOPIC_ROOT, validateAck, validateCommand, validateStatus, validateTelemetry,
  type DeviceId, type Telemetry,
} from '@twin/contracts';
import { verifyMessage } from '@twin/contracts/signing';
import { brokerUrl, caCert, readJsonSecret, secure } from './env';

const { values: a } = parseArgs({
  options: { mqtt: { type: 'string' }, keys: { type: 'string' }, raw: { type: 'boolean', default: false } },
});
const url = a.mqtt ?? brokerUrl();
const keys: Partial<Record<DeviceId, string>> = readJsonSecret(a.keys, 'device-keys.json') ?? {};
// In secure mode the monitor logs in with the read-only "monitor" account.
const creds = secure ? readJsonSecret<Record<string, string>>(undefined, 'mqtt-credentials.json') : undefined;
const validators = { telemetry: validateTelemetry, status: validateStatus, cmd: validateCommand, ack: validateAck };

const c = mqtt.connect(url, {
  clientId: secure ? 'monitor' : `monitor-${process.pid}`,
  username: creds ? 'monitor' : undefined,
  password: creds?.monitor,
  ca: caCert(),
});
c.on('connect', () => {
  console.log(`monitor connected to ${url}, subscribed to ${TOPIC_ROOT}/#`);
  c.subscribe(`${TOPIC_ROOT}/#`);
});
c.on('error', (e) => console.error(e.message));

c.on('message', (topic, payload) => {
  const time = new Date().toISOString().slice(11, 23);
  const t = parseTopic(topic);
  if (!t) return console.log(`${time} ?? foreign topic ${topic}`);
  const text = payload.toString();
  if (a.raw) console.log(text);
  const json = parseJson(text);
  if (!json.ok) return console.log(`${time} XX ${topic} ${json.errors[0]}`);
  const v = validators[t.channel](json.value);
  const key = keys[t.deviceId];
  const sig = key ? (verifyMessage(text, key).ok ? 'sig:ok' : 'sig:BAD') : (text.includes('"sig"') ? 'sig:?' : 'unsigned');
  if (!v.ok) return console.log(`${time} XX ${t.deviceId}/${t.channel} INVALID: ${v.errors.join('; ')}`);
  if (t.channel === 'telemetry') {
    const m = v.value as Telemetry;
    const vals = Object.entries(m.sensors).map(([k, r]) => `${k}=${r.v === null ? '----' : r.v.toFixed(2)}${r.q === 'ok' ? '' : `(${r.q})`}`).join(' ');
    const pump = m.actuators?.pump ? ` pump=${m.actuators.pump.on ? 'ON' : 'off'}/${m.actuators.pump.duty}%` : '';
    console.log(`${time} OK ${t.deviceId.padEnd(15)} #${String(m.seq).padStart(5)} ${vals}${pump} [${sig}]`);
  } else {
    console.log(`${time} OK ${t.deviceId.padEnd(15)} ${t.channel}: ${JSON.stringify(json.value)} [${sig}]`);
  }
});
