/**
 * A2 - Unauthenticated access to the broker.
 * Attacker: knows the address and has the public CA certificate, but no account.
 */
import { BROKER, ca, connect, creds, report, runIfMain, title } from './lib';

export async function main(): Promise<void> {
  title('A2  Unauthenticated / wrong credentials');
  const url = `mqtts://${BROKER}:8883`;

  const tryConnect = async (label: string, opts: object) => {
    try {
      const c = await connect(url, { ca: ca(), ...opts }, 3000);
      c.end(true);
      report(label, 'per-client username/password', false, 'connection ACCEPTED');
    } catch (e) {
      report(label, 'no anonymous access, hashed per-client passwords', true, (e as Error).message);
    }
  };

  await tryConnect('Anonymous connection', { clientId: 'a2-anon' });
  await tryConnect('Guessed password for node-inlet', { clientId: 'node-inlet', username: 'node-inlet', password: 'password123' });
  // A valid password used for another account name does not work either.
  await tryConnect('node-downstream password reused as node-inlet', {
    clientId: 'node-inlet', username: 'node-inlet', password: creds()['node-downstream'],
  });
}

runIfMain(import.meta, main);
