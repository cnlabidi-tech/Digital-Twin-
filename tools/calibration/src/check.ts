/**
 * Bring-up check: listens to the live MQTT traffic (read-only monitor account)
 * and verifies everything the platform needs from the field devices. Run it
 * right after flashing the boards (and against the emulator for comparison).
 *
 *   npm run check -w @twin/calibration -- [--seconds 15] [--commands] [--out file.json]
 *
 * --commands  also measures the command round trip (ping) through the platform
 *             API (logs in as admin with the initial password or TWIN_USER/TWIN_PASSWORD).
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEVICE_IDS, DEVICE_SENSORS, SENSORS, type DeviceId, type Telemetry } from '@twin/contracts';
import { verifyMessage } from '@twin/contracts/signing';
import { API, capture, connectMonitor, deviceKeys, login, mean, secure } from './common';

const { values: a } = parseArgs({
  options: { seconds: { type: 'string', default: '15' }, commands: { type: 'boolean', default: false }, out: { type: 'string' } },
});

type Level = 'PASS' | 'WARN' | 'FAIL';
const rows: Array<{ level: Level; check: string; detail: string }> = [];
const add = (level: Level, check: string, detail: string) => {
  rows.push({ level, check, detail });
  const col = level === 'PASS' ? '\x1b[32m' : level === 'WARN' ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${col}${level}\x1b[0m  ${check.padEnd(46)} ${detail}`);
};

const seconds = Number(a.seconds);
console.log(`Listening ${seconds} s to ${secure ? 'mqtts (monitor account)' : 'mqtt (dev mode)'} ...`);
const c = await connectMonitor();
const { telemetry, status, invalid } = await capture(c, seconds, (n) => process.stdout.write(`\r  ${n} telemetry messages`));
console.log('\n');
c.end(true);

const keys = deviceKeys();
const now = Date.now();
add(invalid.length ? 'FAIL' : 'PASS', 'All messages valid against the data contract', invalid.length ? invalid.slice(0, 3).join(' | ') : `${telemetry.length} messages`);

const last: Partial<Record<DeviceId, Telemetry>> = {};
for (const id of DEVICE_IDS) {
  const msgs = telemetry.filter((m) => m.t.deviceId === id);
  console.log(`--- ${id}`);
  const online = status.filter((s) => s.deviceId === id).map((s) => (s.payload as { online: boolean }).online);
  add(online.includes(true) ? 'PASS' : online.length ? 'FAIL' : 'WARN', 'Retained status = online', online.length ? `online=${online[online.length - 1]}` : 'no status message');
  if (!msgs.length) {
    add('FAIL', 'Telemetry received', 'none - check WiFi, broker address, credentials (serial console: status)');
    continue;
  }
  const t0 = msgs[0]!.t;
  last[id] = msgs[msgs.length - 1]!.t;
  const expected = (seconds * 1000) / t0.intervalMs;
  const ratio = msgs.length / expected;
  add(ratio > 0.8 ? 'PASS' : 'FAIL', 'Telemetry rate', `${msgs.length} msgs in ${seconds} s (expected ~${expected.toFixed(0)}, interval ${t0.intervalMs} ms)`);

  const key = keys[id];
  if (key) {
    const bad = msgs.filter((m) => !verifyMessage(m.raw, key).ok).length;
    add(bad ? 'FAIL' : 'PASS', 'HMAC signatures valid', bad ? `${bad} invalid - device key mismatch: regenerate firmware secrets` : 'all valid');
  } else {
    add(secure ? 'FAIL' : 'WARN', 'HMAC signatures valid', 'no device key available');
  }

  const skews = msgs.map((m) => m.receivedAt - m.t.ts);
  const skew = mean(skews);
  add(Math.abs(skew) < 1000 ? 'PASS' : Math.abs(skew) < 30_000 ? 'WARN' : 'FAIL', 'Device clock (NTP) vs platform clock',
    `mean offset ${skew.toFixed(0)} ms (limit 30 000 ms)${msgs.some((m) => !m.t.diag.ntpSynced) ? ' - device reports NOT synced' : ''}`);

  const seqOk = msgs.every((m, i) => i === 0 || m.t.bootId !== msgs[i - 1]!.t.bootId || m.t.seq > msgs[i - 1]!.t.seq);
  add(seqOk ? 'PASS' : 'FAIL', 'Sequence numbers increasing', seqOk ? `seq ${t0.seq} -> ${last[id]!.seq}` : 'out of order / duplicated');

  for (const s of DEVICE_SENSORS[id]) {
    const vals = msgs.map((m) => m.t.sensors[s]).filter(Boolean);
    const bad = vals.filter((r) => r!.q !== 'ok');
    const v = vals.map((r) => r!.v).filter((x): x is number => typeof x === 'number');
    const spec = SENSORS[s];
    if (bad.length) add('FAIL', `${s} quality`, `${bad.length}/${vals.length} not ok (${bad[0]!.q}) - check wiring / divider / supply`);
    else add(v.every((x) => x >= spec.min && x <= spec.max) ? 'PASS' : 'FAIL', `${s} value in range`, `mean ${mean(v).toFixed(3)} ${spec.unit}, min ${Math.min(...v).toFixed(3)}, max ${Math.max(...v).toFixed(3)}`);
    if (spec.kind === 'flow') {
      const raws = vals.map((r) => r!.raw);
      const mono = raws.every((r, i) => i === 0 || r >= raws[i - 1]!);
      add(mono ? 'PASS' : 'FAIL', `${s} pulse counter monotonic`, `${raws[0]} -> ${raws[raws.length - 1]} pulses`);
    }
  }
  add(msgs.every((m) => m.t.diag.rssi > -80) ? 'PASS' : 'WARN', 'WiFi signal', `RSSI ${last[id]!.diag.rssi} dBm (weak below -80)`);
}

// ----------------------------------------------------------------- cross-device physics
const inl = last['node-inlet'];
const dwn = last['node-downstream'];
if (inl && dwn) {
  console.log('--- pipe (both devices)');
  const pump = inl.actuators?.pump;
  if (pump?.on) {
    const v = (id: 'P1' | 'P2' | 'P3' | 'F1' | 'F2') => (id === 'P1' || id === 'F1' ? inl : dwn).sensors[id]?.v ?? NaN;
    const grad = v('P1') > v('P2') && v('P2') > v('P3');
    add(grad ? 'PASS' : 'WARN', 'Pressure decreases along the pipe (P1>P2>P3)', `${v('P1')} > ${v('P2')} > ${v('P3')} bar${grad ? '' : ' - check sensor order / zero calibration'}`);
    const fl = telemetry.filter((m) => m.t.deviceId === 'node-inlet').map((m) => m.t.sensors.F1?.v ?? 0);
    const fr = telemetry.filter((m) => m.t.deviceId === 'node-downstream').map((m) => m.t.sensors.F2?.v ?? 0);
    const diff = Math.abs(mean(fl) - mean(fr)) / Math.max(mean(fl), 0.01);
    add(diff < 0.05 ? 'PASS' : diff < 0.15 ? 'WARN' : 'FAIL', 'Flow meters agree (no leak, before K calibration)',
      `F1 ${mean(fl).toFixed(3)} vs F2 ${mean(fr).toFixed(3)} L/min (${(diff * 100).toFixed(1)} %)${diff >= 0.05 ? ' - run the flow bucket calibration' : ''}`);
  } else {
    add('WARN', 'Pipe checks', 'pump is OFF: start it to check pressure gradient and flow agreement');
  }
}

// ----------------------------------------------------------------- command round trip
if (a.commands) {
  console.log('--- commands (through the platform)');
  const token = await login();
  if (!token) add('WARN', 'Command round trip', 'cannot log in (set TWIN_USER / TWIN_PASSWORD)');
  for (const id of token ? DEVICE_IDS : []) {
    const r = await fetch(`${API}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: id, type: 'ping', params: {} }),
    });
    const rec = (await r.json()) as { cmdId?: string; error?: string };
    let final: { status: string; latency_ms: number | null; reason: string | null } | undefined;
    for (let i = 0; i < 20 && rec.cmdId; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const list = (await (await fetch(`${API}/api/commands?limit=10`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<{ cmd_id: string; status: string; latency_ms: number | null; reason: string | null }>;
      final = list.find((x) => x.cmd_id === rec.cmdId);
      if (final && final.status !== 'sent' && final.status !== 'pending') break;
    }
    add(final?.status === 'executed' ? 'PASS' : 'FAIL', `${id}: ping round trip`, final ? `${final.status}${final.latency_ms !== null ? ` in ${final.latency_ms} ms` : ''}${final.reason ? ` (${final.reason})` : ''}` : rec.error ?? 'no answer');
  }
}

// ----------------------------------------------------------------- twin commissioning
if (a.commands) {
  const token = await login();
  if (token) {
    console.log('--- twin model (commissioning)');
    const r = (await (await fetch(`${API}/api/twin/commissioning`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      checks: Array<{ level: Level; check: string; detail: string }>;
      detection?: { minLeakFastLpm: number; minLeakFastPercent: number };
    };
    for (const ch of r.checks ?? []) add(ch.level, `twin: ${ch.check}`, ch.detail);
    if (r.detection) console.log(`  fast detection limit: ~${r.detection.minLeakFastLpm} L/min (${r.detection.minLeakFastPercent} % of the flow)`);
  }
}

const fails = rows.filter((r) => r.level === 'FAIL').length;
const warns = rows.filter((r) => r.level === 'WARN').length;
console.log(`\nResult: ${rows.length - fails - warns} pass, ${warns} warn, ${fails} fail`);
if (a.out) writeFileSync(a.out, JSON.stringify({ date: new Date().toISOString(), seconds, rows }, null, 2) + '\n');
process.exit(fails ? 1 : 0);
