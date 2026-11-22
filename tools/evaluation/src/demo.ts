/**
 * Narrated defence demo. Drives the emulator step by step while the jury
 * watches the dashboard (http://localhost:4000). Press Enter between steps.
 *
 *   npm run demo -w @twin/evaluation            (interactive)
 *   npm run demo -w @twin/evaluation -- --auto  (no pauses: rehearsal / video)
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { emu, emuAvailable, Platform, sleep } from './platform';

const { values: a } = parseArgs({ options: { auto: { type: 'boolean', default: false } } });
const p = new Platform();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const C = { b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' };

async function step(n: number, title: string, say: string[]): Promise<void> {
  console.log(`\n${C.b}${C.c}━━ STEP ${n}: ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}${C.x}`);
  for (const s of say) console.log(`   ${s}`);
  if (!a.auto) await rl.question(`${C.y}   [Enter] to run this step${C.x} `);
}
const show = (s: string) => console.log(`   ${C.g}→ ${s}${C.x}`);

async function waitFor(desc: string, pred: () => Promise<boolean>, timeoutS = 40): Promise<number | null> {
  const t0 = Date.now();
  process.stdout.write(`   waiting: ${desc} `);
  while (Date.now() - t0 < timeoutS * 1000) {
    if (await pred()) {
      const s = (Date.now() - t0) / 1000;
      console.log(`${C.g}(${s.toFixed(1)} s)${C.x}`);
      return s;
    }
    process.stdout.write('.');
    await sleep(500);
  }
  console.log(`${C.r}(timeout)${C.x}`);
  return null;
}

async function recover(): Promise<void> {
  await emu('/api/reset', 'POST');
  // pump.set is idempotent: always (re)start it rather than trusting a possibly stale state
  await sleep(1000);
  await p.pump(true, true);
  await waitFor('pipe back to normal (no open loss / FDI alert)', async () => !(await p.alerts()).some((x) => ['leak', 'theft', 'fdi'].includes(x.type)), 90);
  await p.waitMonitoring(60);
  // let the restart transient finish before the next event (detection is paused during it)
  await sleep(12_000);
  await p.waitMonitoring(60);
}

async function main() {
  if (!(await emuAvailable())) throw new Error('start the emulator: docker compose --profile sim up -d');
  await p.login();
  await emu('/api/reset', 'POST');

  await step(1, 'The digital twin mirrors the pipe', [
    'Dashboard: schematic, live values, twin panel (measured vs expected), residuals near 0.',
    'The twin LEARNED the pipe physics from 60 s of healthy operation (pump curve, friction, outlet).',
  ]);
  const t = await p.twin();
  if (!t.state?.measured?.pumpOn) await p.pump(true, true);
  await waitFor('twin in monitoring mode', async () => (await p.twin()).state?.mode === 'monitoring', 150);
  show('all residuals within ±5 σ: physics consistent');

  await step(2, 'Operating change is NOT an alarm', [
    'Close the outlet valve to 55 %: flow and pressures change a lot,',
    'but mass is conserved and the physics still holds -> no alarm.',
  ]);
  await emu('/api/valve', 'POST', { outletOpening: 0.55 });
  await sleep(15_000);
  const fa = (await p.alerts()).filter((x) => ['leak', 'theft', 'fdi'].includes(x.type));
  show(fa.length ? `unexpected alert: ${fa[0]!.message}` : 'no alarm after 15 s (transient recognised as an operating change)');
  await emu('/api/valve', 'POST', { outletOpening: 1 });
  await sleep(12_000);

  await step(3, 'Leak in segment B: detect, locate, act', [
    'A 0.5 L/min leak opens at 3.0 m (middle of segment B).',
    'Watch: mass balance + CUSUM rise, location marker, alert, automatic pump stop (signed command + ack).',
  ]);
  const tLeak = Date.now();
  const autoStopSince = async (t: number) =>
    (await p.commands(5)).some((c) => c.issued_by === 'auto:twin' && c.verified && new Date(c.created_at).getTime() >= t);
  await emu('/api/leak', 'POST', { segment: 'B', fraction: 0.5, rateLpm: 0.5 });
  await waitFor('leak alert', async () => (await p.alerts()).some((x) => x.key === 'loss'));
  await waitFor('classified, automatic pump stop acknowledged and verified', () => autoStopSince(tLeak), 40);
  const leak = (await p.alerts()).find((x) => x.key === 'loss');
  show(leak?.message ?? '');

  await step(4, 'Repair and restart (interlock + audit)', [
    'The pump cannot be restarted while the leak alert is open, except by an admin override (audited).',
  ]);
  await recover();
  show('repaired, pump restarted with an audited override, alert resolved when the mass balance returned to normal');

  await step(5, 'Theft: a valve opened slowly on a branch', [
    'Physically a theft is also a loss; the twin separates it by its onset (hand-opened valve, ~10 s).',
  ]);
  const tTheft = Date.now();
  await emu('/api/theft', 'POST', { segment: 'B', fraction: 0.6, rateLpm: 0.9, rampS: 10 });
  await waitFor('theft classification and automatic stop', async () => (await p.alerts()).some((x) => x.key === 'loss' && x.type === 'theft') && (await autoStopSince(tTheft)), 50);
  show((await p.alerts()).find((x) => x.key === 'loss')?.message ?? '');
  await recover();

  await step(6, 'Cyber-attack: a compromised node forges its flow meter', [
    'The inlet node is hacked: it reports F1 +0.6 L/min, correctly SIGNED (it holds the key).',
    'Crypto cannot see it. A naive system would see a leak and shut the pipeline down (DoS).',
    'The twin: pump curve says P1 does not match that flow -> data inconsistent, suspect F1, NO shutdown.',
  ]);
  const tAtk = Date.now();
  const atk = await emu<{ id: string }>('/api/attacks', 'POST', { type: 'fdi_bias', sensor: 'F1', delta: 0.6 });
  let fdiMsg = '';
  await waitFor('integrity (FDI) alarm', async () => {
    const a = (await p.alerts()).find((x) => x.key === 'integrity') ?? (await p.alerts()).find((x) => x.type === 'fdi');
    if (a) fdiMsg = a.message;
    return !!a;
  });
  await sleep(8000);
  const stopped = (await p.commands(5)).some((c) => c.issued_by === 'auto:twin' && new Date(c.created_at).getTime() >= tAtk);
  show(fdiMsg.slice(0, 170));
  show(stopped ? 'WARNING: pump was stopped' : 'no automatic shutdown on doubtful data');
  await emu(`/api/attacks/${atk.id}`, 'DELETE');
  await recover();

  await step(7, 'Network attacks and accountability', [
    'Run in another terminal:  npm run all -w @twin/attacks   (24 attacks, all blocked)',
    'Dashboard > Security: rejected traffic by reason; Audit log > verify chain.',
  ]);
  const v = await p.get<{ ok: boolean; rows: number }>('/api/audit/verify');
  show(`audit log hash chain: ${v.ok ? 'intact' : 'BROKEN'} (${v.rows} entries)`);

  console.log(`\n${C.b}Demo finished.${C.x} Results: docs/results/evaluation.md, live-emulator.md, security-tests.json`);
  rl.close();
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
