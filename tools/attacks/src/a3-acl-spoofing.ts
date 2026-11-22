/**
 * A3 - Topic spoofing with a stolen DEVICE account.
 *
 * Attacker: extracted node-downstream's MQTT password (e.g. from a stolen
 * board). Tries to (a) publish fake telemetry as node-inlet, (b) send a
 * command to the pump, (c) spy on all traffic. The broker ACL confines the
 * account to pipeline/v1/node-downstream/... The read-only "monitor" account
 * watches whether anything gets through.
 */
import { as, report, runIfMain, sleep, title } from './lib';

export async function main(): Promise<void> {
  title('A3  Topic spoofing with a stolen device account (ACL)');
  const watcher = await as('monitor');
  const seen: string[] = [];
  watcher.on('message', (t, p) => {
    if (p.toString().includes('A3-FORGED')) seen.push(t);
  });
  await watcher.subscribeAsync('pipeline/v1/#');

  // The broker forces client id = username, so this login takes over the real device's session.
  const thief = await as('node-downstream', { clientId: 'node-downstream' }).catch(() => null);
  if (!thief) {
    report('Login with stolen node-downstream account', 'n/a', false, 'could not log in with valid credentials');
    return;
  }
  const spied: string[] = [];
  thief.on('message', (t) => spied.push(t));
  await thief.subscribeAsync('pipeline/v1/#');

  const fake = JSON.stringify({ v: 1, deviceId: 'node-inlet', note: 'A3-FORGED' });
  await thief.publishAsync('pipeline/v1/node-inlet/telemetry', fake, { qos: 1 });
  await thief.publishAsync('pipeline/v1/node-inlet/cmd', JSON.stringify({ type: 'pump.set', params: { on: false }, note: 'A3-FORGED' }), { qos: 1 });
  await sleep(2000);

  const forgedThrough = seen.filter((t) => t.includes('node-inlet'));
  report('Publish fake telemetry / command as node-inlet', 'broker ACL: a device writes only pipeline/v1/<its id>/...', forgedThrough.length === 0,
    forgedThrough.length ? `delivered on ${forgedThrough.join(', ')}` : 'messages silently dropped by the broker (monitor saw nothing)');
  const foreign = spied.filter((t) => !t.endsWith('node-downstream/cmd'));
  report('Spy on all topics with the device account', 'broker ACL: a device reads only its own cmd topic', foreign.length === 0,
    foreign.length ? `received ${foreign.length} foreign messages` : 'subscription to pipeline/v1/# delivered nothing');

  thief.end(true);
  watcher.end(true);
  console.log('  note: the real node-downstream was disconnected while its account was used (client id = username);\n' +
    '        it reconnects automatically, and the platform shows the outage - a stolen-credential login is itself visible.');
}

runIfMain(import.meta, main);
