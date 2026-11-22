/**
 * A1 - Eavesdropping and man-in-the-middle on the MQTT link.
 *
 * Attacker: on the same network, wants to read telemetry/credentials or to
 * impersonate the broker.
 *  a) plain-text MQTT (port 1883): must be unavailable -> nothing to sniff.
 *  b) a fake broker / MITM presents a certificate NOT signed by our CA: a
 *     client that trusts only our CA refuses it.
 *  c) the real broker is reached under a name not in its certificate (DNS
 *     spoofing): hostname verification fails.
 */
import { BROKER, ca, connect, report, runIfMain, title } from './lib';

export async function main(): Promise<void> {
  title('A1  Eavesdropping / man-in-the-middle');

  try {
    const c = await connect(`mqtt://${BROKER}:1883`, { clientId: 'a1-sniffer' }, 3000);
    c.end(true);
    report('Connect in plain text on 1883', 'TLS-only broker', false, 'plain-text connection ACCEPTED');
  } catch (e) {
    report('Connect in plain text on 1883', 'TLS-only broker (no plain listener)', true, `refused: ${(e as Error).message}`);
  }

  try {
    // No CA given: Node trusts only public CAs, exactly like a device that would face a forged broker certificate.
    const c = await connect(`mqtts://${BROKER}:8883`, { clientId: 'a1-mitm', rejectUnauthorized: true }, 3000);
    c.end(true);
    report('TLS with an untrusted certificate (MITM)', 'certificate pinned to our CA', false, 'untrusted certificate accepted');
  } catch (e) {
    report('TLS with an untrusted certificate (MITM)', 'clients trust only the project CA', true, (e as Error).message);
  }

  try {
    // 127.0.0.2 reaches the same broker but is not in the certificate's SAN list.
    const c = await connect('mqtts://127.0.0.2:8883', { clientId: 'a1-dns', ca: ca() }, 3000);
    c.end(true);
    report('Broker reached under a spoofed name', 'hostname verification', false, 'name mismatch accepted');
  } catch (e) {
    report('Broker reached under a spoofed name', 'hostname verification (SAN)', true, (e as Error).message);
  }
}

runIfMain(import.meta, main);
