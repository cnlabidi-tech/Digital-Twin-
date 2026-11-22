/**
 * A6 - Message flood on a device topic (resource exhaustion of the ingestion).
 * Attacker: privileged broker account. Sends 400 messages as fast as possible.
 * Defence: per-device rate limit in the security gate (20 msg/s); the twin
 * keeps running on the genuine data. (Bounded, local test against our own lab.)
 */
import { topicFor } from '@twin/contracts';
import { adminToken, apiGet, as, diff, nextMessage, rejectedCounts, report, runIfMain, sleep, title } from './lib';

export async function main(): Promise<void> {
  title('A6  Flood of messages on one device topic');
  const token = await adminToken();
  const rt = await as('redteam');
  const topic = topicFor('node-inlet', 'telemetry');
  const sample = await nextMessage(rt, topic, 5000);
  if (!sample) throw new Error('no telemetry captured');
  const before = await rejectedCounts(token);
  const acceptedBefore = (await apiGet<{ ingestion: { accepted: number } }>('/api/health', token)).ingestion.accepted;
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) rt.publish(topic, sample.replace(/"nonce":"[0-9a-f]{16}"/, `"nonce":"${i.toString(16).padStart(16, 'f')}"`));
  const sendMs = Date.now() - t0;
  await sleep(1500);
  const d = diff(before, await rejectedCounts(token));
  const total = Object.values(d).reduce((a, b) => a + b, 0);
  report(`400 messages queued in ${sendMs} ms`, 'per-device rate limit + signature check', total >= 350,
    `rejected ${total}/400: ${JSON.stringify(d)}`);
  const health = await apiGet<{ mqtt: boolean; ingestion: { accepted: number } }>('/api/health', token);
  const genuine = health.ingestion.accepted - acceptedBefore;
  report('Genuine telemetry still accepted during the flood', 'forged messages rejected before the rate limit', health.mqtt && genuine >= 4,
    `${genuine} genuine messages accepted in the same 1.5 s; backend MQTT connected: ${health.mqtt}`);
  rt.end(true);
}

runIfMain(import.meta, main);
