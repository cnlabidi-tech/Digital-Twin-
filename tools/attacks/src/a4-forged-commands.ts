/**
 * A4 - Forged and replayed COMMANDS (attack on the actuator).
 *
 * Attacker: controls a PRIVILEGED broker account ("redteam", or a compromised
 * broker), so the ACL no longer protects the command topic. The last line of
 * defence is on the device itself (emulator = same logic as the firmware):
 *   a) unsigned command                 -> rejected: missing_signature
 *   b) command signed with a wrong key  -> rejected: bad_signature
 *   c) a REAL command captured and replayed byte-for-byte -> rejected: replayed_nonce
 *   d) (--slow) the captured command replayed after 35 s  -> rejected: stale_timestamp
 * Evidence: the device's acknowledgements and the pump state.
 */
import { randomBytes } from 'node:crypto';
import { newCmdId, newNonce, topicFor } from '@twin/contracts';
import { signMessage } from '@twin/contracts/signing';
import { adminToken, API, as, nextMessage, report, runIfMain, sleep, title } from './lib';

export async function main(): Promise<void> {
  title('A4  Forged / replayed commands to the pump');
  const rt = await as('redteam');
  const ackTopic = topicFor('node-inlet', 'ack');
  const cmdTopic = topicFor('node-inlet', 'cmd');
  await rt.subscribeAsync(ackTopic);

  const sendAndAck = async (wire: string, cmdId: string) => {
    const acks: string[] = [];
    const on = (t: string, p: Buffer) => t === ackTopic && p.toString().includes(cmdId) && acks.push(p.toString());
    rt.on('message', on);
    await rt.publishAsync(cmdTopic, wire, { qos: 1 });
    for (let i = 0; i < 30 && !acks.length; i++) await sleep(100);
    rt.removeListener('message', on);
    return acks[acks.length - 1] ? (JSON.parse(acks[acks.length - 1]!) as { status: string; reason?: string; state?: unknown }) : null;
  };
  const base = () => ({ v: 1, cmdId: newCmdId(), deviceId: 'node-inlet', ts: Date.now(), nonce: newNonce(), issuedBy: 'user:admin', type: 'pump.set', params: { on: false } });

  // a) unsigned
  const a = base();
  const ackA = await sendAndAck(JSON.stringify(a), a.cmdId);
  report('Unsigned "stop pump" command', 'device verifies HMAC signature', ackA?.status === 'rejected', ackA ? `ack: ${ackA.status} (${ackA.reason})` : 'no ack');

  // b) wrong key
  const b = base();
  const ackB = await sendAndAck(signMessage(b, randomBytes(32).toString('hex')), b.cmdId);
  report('Command signed with a guessed key', 'device verifies HMAC signature', ackB?.status === 'rejected', ackB ? `ack: ${ackB.status} (${ackB.reason})` : 'no ack');

  // c) capture a genuine command (sent by an admin through the platform) and replay it
  await rt.subscribeAsync(cmdTopic);
  const token = await adminToken();
  const captured = nextMessage(rt, cmdTopic, 5000);
  await fetch(`${API}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId: 'node-inlet', type: 'ping', params: {} }),
  });
  const genuine = await captured;
  if (!genuine) {
    report('Replay of a captured genuine command', 'nonce cache', false, 'could not capture a command');
  } else {
    await sleep(500); // let the genuine one be executed first
    const id = (JSON.parse(genuine) as { cmdId: string }).cmdId;
    const ackC = await sendAndAck(genuine, id);
    report('Replay of a captured genuine (signed) command', 'device nonce cache (anti-replay)', ackC?.status === 'rejected', ackC ? `ack: ${ackC.status} (${ackC.reason})` : 'no ack');

    if (process.argv.includes('--slow')) {
      console.log('  waiting 35 s to replay the captured command after the freshness window...');
      await sleep(35_000);
      const ackD = await sendAndAck(genuine, id);
      report('Replay of the captured command 35 s later', 'timestamp freshness window (30 s)', ackD?.status === 'rejected', ackD ? `ack: ${ackD.status} (${ackD.reason})` : 'no ack');
    }
  }
  rt.end(true);
}

runIfMain(import.meta, main);
