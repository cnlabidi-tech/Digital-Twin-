/**
 * A7 - False data injection by a COMPROMISED DEVICE.
 *
 * The attacker controls a node's firmware: its messages are correctly signed,
 * fresh and well-formed, so every cryptographic check passes. Only physics and
 * plausibility can reveal the lie. Uses the emulator's attack injection
 * (requires: docker compose --profile sim, or `npm run emu`).
 *
 *  a) inlet reports F1 +0.6 L/min       -> goal: fake leak + automatic shutdown (DoS)
 *  b) downstream replays recorded "normal" values while a real leak happens -> goal: hide the leak
 *  c) inlet freezes P1 at its current value -> goal: hide pressure changes
 * Expected: integrity/FDI alarm with the right suspect; no fake "leak" alarm;
 * no automatic pump stop on manipulated data.
 */
import { adminToken, apiGet, emu, emuAvailable, report, runIfMain, sleep, title } from './lib';

interface Alert { key: string; type: string; message: string; data: { suspects?: string[]; check?: string } | null; created_at: string }

async function waitAlert(token: string, pred: (a: Alert) => boolean, timeoutS: number): Promise<{ alert: Alert; afterS: number } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const alerts = await apiGet<Alert[]>('/api/alerts', token);
    const a = alerts.find(pred);
    if (a) return { alert: a, afterS: (Date.now() - t0) / 1000 };
    await sleep(500);
  }
  return null;
}

async function waitClear(token: string, timeoutS = 60): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const alerts = await apiGet<Alert[]>('/api/alerts', token);
    if (!alerts.some((a) => ['fdi', 'leak', 'theft'].includes(a.type))) return;
    await sleep(1000);
  }
}

async function autoStops(token: string, sinceMs: number): Promise<number> {
  const cmds = await apiGet<Array<{ issued_by: string; created_at: string }>>('/api/commands?limit=20', token);
  return cmds.filter((c) => c.issued_by === 'auto:twin' && new Date(c.created_at).getTime() >= sinceMs).length;
}

export async function main(): Promise<void> {
  title('A7  False data injection by a compromised (correctly signing) device');
  if (!(await emuAvailable())) {
    console.log('  skipped: emulator not running (start it with docker compose --profile sim up -d)');
    return;
  }
  const token = await adminToken();
  const twin = await apiGet<{ state: { mode: string } | null }>('/api/twin', token);
  if (twin.state?.mode !== 'monitoring') console.log(`  note: twin mode is "${twin.state?.mode}" - results need a learned model (60 s of normal operation)`);
  await emu('/api/reset', 'POST');
  await waitClear(token);

  // a) fake leak on F1
  let t0 = Date.now();
  let atk = (await emu('/api/attacks', 'POST', { type: 'fdi_bias', sensor: 'F1', delta: 0.6 })) as { id: string };
  let r = await waitAlert(token, (a) => a.type === 'fdi', 30);
  await sleep(3000);
  let leakAlarm = (await apiGet<Alert[]>('/api/alerts', token)).some((a) => a.type === 'leak' || a.type === 'theft');
  report('Forged F1 (+0.6 L/min) to fake a leak', 'physical consistency (pump curve vs flow) + suspect isolation',
    !!r && !leakAlarm && (await autoStops(token, t0)) === 0,
    r ? `FDI alarm after ${r.afterS.toFixed(1)} s: "${r.alert.message.slice(0, 110)}"; fake leak alarm: ${leakAlarm}; automatic stops: 0` : 'no FDI alarm');
  await emu(`/api/attacks/${atk.id}`, 'DELETE');
  await waitClear(token);

  // b) replay downstream values to hide a real leak
  t0 = Date.now();
  atk = (await emu('/api/attacks', 'POST', { type: 'fdi_replay', device: 'node-downstream', recordS: 20 })) as { id: string };
  console.log('  recording 20 s of normal downstream data (attacker side)...');
  await sleep(22_000);
  const leak = (await emu('/api/leak', 'POST', { segment: 'B', rateLpm: 0.6 })) as { id: string };
  r = await waitAlert(token, (a) => a.type === 'fdi', 40);
  const stops = await autoStops(token, t0);
  report('Downstream replays "normal" data while a real leak happens', 'pressure-profile feasibility + replayed-sequence detection',
    !!r, r ? `alarm after ${r.afterS.toFixed(1)} s: "${r.alert.message.slice(0, 130)}"; automatic stop on doubtful data: ${stops}` : 'leak hidden, no alarm');
  await emu(`/api/taps/${leak.id}`, 'DELETE');
  await emu(`/api/attacks/${atk.id}`, 'DELETE');
  await waitClear(token, 90);

  // c) frozen P1
  atk = (await emu('/api/attacks', 'POST', { type: 'fdi_freeze', sensor: 'P1' })) as { id: string };
  r = await waitAlert(token, (a) => a.type === 'fdi' && a.key.startsWith('fdi:P1'), 30);
  report('P1 frozen at its current value', 'plausibility: real sensors are never perfectly constant', !!r,
    r ? `alarm after ${r.afterS.toFixed(1)} s: "${r.alert.message}"` : 'not detected');
  await emu(`/api/attacks/${atk.id}`, 'DELETE');
  await emu('/api/reset', 'POST');
}

runIfMain(import.meta, main);
