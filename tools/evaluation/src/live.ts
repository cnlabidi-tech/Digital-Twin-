/**
 * Live end-to-end evaluation through the whole running platform:
 * device -> MQTT/TLS -> security gate -> twin -> alert -> supervisor -> signed
 * command -> device -> ack -> verification. Times are measured from the
 * physical event to what the operator sees.
 *
 *   npm run live -w @twin/evaluation -- [--mode emulator|manual] [--reps 2]
 *
 * emulator: events are injected through the emulator API (repeatable).
 * manual:   the operator performs each action on the real rig and presses
 *           Enter at the moment of the action (Phase 8 hardware tests).
 * Results: docs/results/live-<mode>.json and .md
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { emu, emuAvailable, Platform, sleep, type Alert } from './platform';

const { values: a } = parseArgs({ options: { mode: { type: 'string', default: 'emulator' }, reps: { type: 'string', default: '2' } } });
const manual = a.mode === 'manual';
const p = new Platform();
const rl = manual ? createInterface({ input: process.stdin, output: process.stdout }) : null;

interface Row { scenario: string; expected: string; outcome: string; ok: boolean; detectS?: number; stopS?: number; verifiedS?: number; detail: string }
const rows: Row[] = [];

async function act(instruction: string, injector: () => Promise<unknown>): Promise<number> {
  if (manual) {
    await rl!.question(`\n>>> ${instruction} - press Enter AT THE MOMENT you do it `);
    return Date.now();
  }
  const t0 = Date.now();
  await injector();
  return t0;
}

async function clearAndRestart(undo: () => Promise<unknown>, instruction: string): Promise<void> {
  if (manual) await rl!.question(`\n>>> ${instruction}, then press Enter `);
  else await undo();
  // operator confirms the repair: restart the pump (interlock override = admin)
  // pump.set is idempotent: always (re)start it rather than trusting a possibly stale state
  await sleep(1000);
  await p.pump(true, true);
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    const open = (await p.alerts()).filter((x) => ['leak', 'theft', 'fdi'].includes(x.type));
    if (!open.length) break;
    await sleep(1000);
  }
  await p.waitMonitoring(60);
  await sleep(5000);
}

async function lossScenario(name: string, expectType: 'leak' | 'theft', segment: 'A' | 'B', instruction: string, inject: () => Promise<{ id: string }>) {
  let id = '';
  const t0 = await act(instruction, async () => (id = (await inject()).id));
  const det = await p.waitAlert((x) => x.key === 'loss', t0, 40);
  // automatic stop executed and verified?
  let stopS: number | undefined;
  let verifiedS: number | undefined;
  for (let i = 0; i < 80; i++) {
    const c = (await p.commands(5)).find((x) => x.issued_by === 'auto:twin' && new Date(x.created_at).getTime() >= t0);
    if (c?.status === 'executed') stopS ??= (new Date(c.acked_at ?? c.created_at).getTime() - t0) / 1000;
    if (c?.verified) {
      verifiedS = (Date.now() - t0) / 1000;
      break;
    }
    await sleep(250);
  }
  // final classification after it settled
  await sleep(3000);
  const final = (await p.alerts()).find((x) => x.key === 'loss') ?? det?.alert;
  const ok = !!det && final?.type === expectType && final?.segment === segment && stopS !== undefined;
  rows.push({
    scenario: name, expected: `${expectType}, segment ${segment}, pump stopped`, ok,
    outcome: det ? `${final?.type}, segment ${final?.segment ?? '?'}${stopS !== undefined ? ', pump stopped' : ', NO stop'}` : 'not detected',
    detectS: det?.delayS, stopS, verifiedS, detail: final?.message.slice(0, 140) ?? '',
  });
  await clearAndRestart(() => emu(`/api/taps/${id}`, 'DELETE'), 'Close the valve (repair)');
}

async function main() {
  if (!manual && !(await emuAvailable())) throw new Error('emulator not reachable (docker compose --profile sim up -d) - or use --mode manual');
  await p.login();
  console.log(`Live evaluation (${manual ? 'manual, real rig' : 'emulator'}); waiting for the twin to monitor...`);
  if (!manual) await emu('/api/reset', 'POST');
  const twin = await p.twin();
  if (!twin.state?.measured?.pumpOn) await p.pump(true, true);
  if (!(await p.waitMonitoring(150))) throw new Error('twin not monitoring (no model / pump off)');
  await sleep(5000);

  for (let rep = 0; rep < Number(a.reps); rep++) {
    console.log(`\n--- repetition ${rep + 1}`);
    await lossScenario('Leak segment A (0.5 L/min, sudden)', 'leak', 'A', 'Open the LEAK valve in segment A quickly',
      () => emu('/api/leak', 'POST', { segment: 'A', fraction: 0.5, rateLpm: 0.5 }));
    await lossScenario('Leak segment B (0.5 L/min, sudden)', 'leak', 'B', 'Open the LEAK valve in segment B quickly',
      () => emu('/api/leak', 'POST', { segment: 'B', fraction: 0.5, rateLpm: 0.5 }));
    await lossScenario('Theft segment B (0.9 L/min, 10 s opening)', 'theft', 'B', 'Open the THEFT valve SLOWLY over ~10 s',
      () => emu('/api/theft', 'POST', { segment: 'B', fraction: 0.6, rateLpm: 0.9, rampS: 10 }));

    // operating change: must NOT alarm
    const t0 = await act('Close the OUTLET valve about half-way', () => emu('/api/valve', 'POST', { outletOpening: 0.55 }));
    const fa = await p.waitAlert((x) => ['leak', 'theft', 'fdi'].includes(x.type), t0, 45);
    rows.push({ scenario: 'Outlet valve change (operating change)', expected: 'no alarm', ok: !fa, outcome: fa ? `FALSE ALARM: ${fa.alert.type}` : 'no alarm (45 s)', detail: '' });
    if (manual) await rl!.question('\n>>> Re-open the outlet valve fully, then press Enter ');
    else await emu('/api/valve', 'POST', { outletOpening: 1 });
    await sleep(20_000);

    // compromised device (emulator only): fake leak by forged F1
    if (!manual) {
      const ts = Date.now();
      const atk = await emu<{ id: string }>('/api/attacks', 'POST', { type: 'fdi_bias', sensor: 'F1', delta: 0.6 });
      const det = await p.waitAlert((x: Alert) => x.type === 'fdi', ts, 30);
      await sleep(8000);
      const stop = (await p.commands(5)).find((x) => x.issued_by === 'auto:twin' && new Date(x.created_at).getTime() >= ts);
      const leak = (await p.alerts()).find((x) => x.type === 'leak' || x.type === 'theft');
      rows.push({
        scenario: 'FDI: compromised inlet forges F1 +0.6 L/min', expected: 'integrity alarm, no leak alarm, no shutdown',
        ok: !!det && !stop && !leak, detectS: det?.delayS,
        outcome: `${det ? 'integrity alarm' : 'NOT detected'}${leak ? ', false leak alarm' : ''}${stop ? ', FALSE SHUTDOWN' : ', no shutdown'}`,
        detail: det?.alert.message.slice(0, 140) ?? '',
      });
      await emu(`/api/attacks/${atk.id}`, 'DELETE');
      await clearAndRestart(async () => undefined, '');
    }
  }
  rl?.close();

  // ------------------------------------------------------------------ report
  const med = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]! : NaN);
  const det = rows.filter((r) => r.detectS !== undefined).map((r) => r.detectS!);
  const stop = rows.filter((r) => r.stopS !== undefined).map((r) => r.stopS!);
  const out = resolve(import.meta.dirname, '../../../docs/results');
  writeFileSync(resolve(out, `live-${a.mode}.json`), JSON.stringify({ date: new Date().toISOString(), mode: a.mode, rows }, null, 2) + '\n');
  const md = `# Live end-to-end evaluation (${a.mode})

Generated by \`npm run live -w @twin/evaluation -- --mode ${a.mode}\` on ${new Date().toISOString().slice(0, 16)}.
Delays measured from the physical event to the alert visible through the API
(polling 250 ms), and to the device acknowledging the automatic pump stop.

| Scenario | Expected | Outcome | OK | Detection | Pump stop acked | Stop verified |
|----------|----------|---------|----|-----------|-----------------|---------------|
${rows.map((r) => `| ${r.scenario} | ${r.expected} | ${r.outcome} | ${r.ok ? 'yes' : '**no**'} | ${r.detectS?.toFixed(1) ?? '-'} s | ${r.stopS?.toFixed(1) ?? '-'} s | ${r.verifiedS?.toFixed(1) ?? '-'} s |`).join('\n')}

Passed ${rows.filter((r) => r.ok).length}/${rows.length}. Median detection ${med(det).toFixed(1)} s, median time to pump stop ${med(stop).toFixed(1)} s.
`;
  writeFileSync(resolve(out, `live-${a.mode}.md`), md);
  console.log(`\n${md}`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
