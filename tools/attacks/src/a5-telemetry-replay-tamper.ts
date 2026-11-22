/**
 * A5 - Forged, tampered and replayed TELEMETRY (attack on the twin's input).
 *
 * Attacker: privileged broker account ("redteam"), can write any device topic.
 *   a) fabricated unsigned telemetry ("everything normal")  -> missing_signature
 *   b) a genuine message with one value changed              -> bad_signature
 *   c) a genuine message re-sent byte-for-byte               -> replayed_nonce
 *   d) (--slow) a genuine message re-sent 35 s later         -> stale_timestamp
 * Evidence: the backend security-gate counters (/api/security/status).
 */
import { newNonce, topicFor } from '@twin/contracts';
import { adminToken, as, diff, nextMessage, rejectedCounts, report, runIfMain, sleep, title } from './lib';

export async function main(): Promise<void> {
  title('A5  Forged / tampered / replayed telemetry');
  const token = await adminToken();
  const rt = await as('redteam');
  const topic = topicFor('node-downstream', 'telemetry');
  const genuine = await nextMessage(rt, topic, 5000);
  if (!genuine) throw new Error('no telemetry captured - is the emulator (or a board) running?');

  const check = async (label: string, defence: string, payload: string, expect: string) => {
    const before = await rejectedCounts(token);
    await rt.publishAsync(topic, payload, { qos: 1 });
    await sleep(800);
    const d = diff(before, await rejectedCounts(token));
    report(label, defence, (d[expect] ?? 0) >= 1, Object.keys(d).length ? `backend rejected: ${JSON.stringify(d)}` : 'NOT rejected');
  };

  // a) fabricated, unsigned
  const g = JSON.parse(genuine) as Record<string, unknown> & { sig?: string; nonce: string; ts: number; seq: number };
  const { sig: _sig, ...unsigned } = { ...g, ts: Date.now(), nonce: newNonce(), seq: g.seq + 100 };
  await check('Fabricated unsigned telemetry', 'signature required', JSON.stringify(unsigned), 'missing_signature');

  // b) tampered value, original signature kept
  const tampered = genuine.replace(/"F2":\{"v":([\d.]+)/, (_m, v) => `"F2":{"v":${(Number(v) + 1).toFixed(3)}`);
  await check('Genuine message with F2 changed (+1 L/min)', 'HMAC over the exact bytes', tampered, 'bad_signature');

  // c) exact replay
  await check('Exact replay of a captured message', 'nonce cache + sequence numbers', genuine, 'replayed_nonce');

  if (process.argv.includes('--slow')) {
    console.log('  waiting 35 s ...');
    await sleep(35_000);
    await check('Replay 35 s later', 'timestamp freshness (30 s)', genuine, 'stale_timestamp');
  }
  rt.end(true);
}

runIfMain(import.meta, main);
