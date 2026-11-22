/**
 * One-time security setup. Generates everything into ./secrets (git-ignored):
 *
 *   ca.crt / ca.key              our own Certificate Authority (10 years)
 *   server.crt / server.key      broker TLS certificate signed by the CA (2 years)
 *   mosquitto/passwd             hashed MQTT passwords (one account per client)
 *   mosquitto/acl                topic ACLs (each device confined to its own sub-tree)
 *   device-keys.json             per-device HMAC-SHA256 keys (message signing)
 *   mqtt-credentials.json        plaintext MQTT passwords (for the firmware/emulator config)
 *   backend.env, emulator.env    environment files used by docker-compose
 *   initial-users.json           first dashboard passwords (change after first login)
 *
 *   npm run setup -w @twin/security -- [--san 192.168.1.50] [--san mypc.local] [--force]
 *
 * --san adds the address the ESP32s use to reach the broker (LAN IP of the PC):
 * the board checks that the certificate matches it.
 * Existing secrets are kept unless --force is given (rotating keys breaks paired devices).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import forge from 'node-forge';
import { DEVICE_IDS } from '@twin/contracts';
import { passwordFile } from './mosquitto-passwd';

const { values: args } = parseArgs({
  options: {
    san: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
    out: { type: 'string' },
    'no-redteam': { type: 'boolean', default: false },
  },
});
const OUT = resolve(args.out ?? resolve(import.meta.dirname, '../../../secrets'));
if (existsSync(resolve(OUT, 'ca.crt')) && !args.force) {
  console.log(`Secrets already exist in ${OUT}. Use --force to regenerate (devices must then be re-flashed).`);
  process.exit(0);
}
mkdirSync(resolve(OUT, 'mosquitto'), { recursive: true });

const write = (name: string, content: string, mode = 0o600) => {
  writeFileSync(resolve(OUT, name), content, { mode });
  chmodSync(resolve(OUT, name), mode); // `mode` above only applies when the file is created
  console.log(`  wrote secrets/${name}`);
};
const secret = (bytes = 18) => randomBytes(bytes).toString('base64url');

// ------------------------------------------------------------ certificates
function makeCert(opts: {
  cn: string;
  days: number;
  isCA: boolean;
  issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };
  sans?: string[];
}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + opts.days * 86_400_000);
  const subject = [{ name: 'commonName', value: opts.cn }, { name: 'organizationName', value: 'Pipeline Twin Lab' }];
  cert.setSubject(subject);
  cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
  const ext: object[] = [
    { name: 'basicConstraints', cA: opts.isCA, critical: true },
    { name: 'keyUsage', keyCertSign: opts.isCA, cRLSign: opts.isCA, digitalSignature: true, keyEncipherment: !opts.isCA, critical: true },
    { name: 'subjectKeyIdentifier' },
  ];
  if (!opts.isCA) {
    ext.push({ name: 'extKeyUsage', serverAuth: true });
    ext.push({
      name: 'subjectAltName',
      // IP addresses are listed twice: as IP SAN (standard clients) and as DNS SAN,
      // because mbedTLS on the ESP32 only matches the host against DNS names.
      altNames: (opts.sans ?? []).flatMap((s) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(s) ? [{ type: 7, ip: s }, { type: 2, value: s }] : [{ type: 2, value: s }],
      ),
    });
  }
  cert.setExtensions(ext);
  cert.sign(opts.issuer?.key ?? keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

console.log('Generating CA and broker certificate (RSA 2048, SHA-256)...');
const ca = makeCert({ cn: 'Pipeline Twin Root CA', days: 3650, isCA: true });
const sans = ['localhost', 'mosquitto', '127.0.0.1', ...(args.san ?? [])];
const server = makeCert({ cn: 'mosquitto', days: 730, isCA: false, issuer: ca, sans });
write('ca.crt', forge.pki.certificateToPem(ca.cert), 0o644);
write('ca.key', forge.pki.privateKeyToPem(ca.key));
write('server.crt', forge.pki.certificateToPem(server.cert), 0o644);
// mosquitto runs as an unprivileged user inside its container: the key must be readable.
write('server.key', forge.pki.privateKeyToPem(server.key), 0o644);

// ------------------------------------------------------------ MQTT accounts
const mqtt: Record<string, string> = { backend: secret(), monitor: secret() };
for (const d of DEVICE_IDS) mqtt[d] = secret();
// LAB ONLY: "redteam" models an attacker who stole a PRIVILEGED broker account
// (or compromised the broker). It lets the attack scripts show that the deeper
// layers (signatures, anti-replay, physics) still hold. Omit with --no-redteam
// and never create it on a real installation.
const redteam = !args['no-redteam'];
if (redteam) mqtt.redteam = secret();
write('mqtt-credentials.json', JSON.stringify(mqtt, null, 2));
write('mosquitto/passwd', passwordFile(mqtt), 0o644);
write(
  'mosquitto/acl',
  `# Generated by tools/security. Default: deny everything not listed.
# Platform backend: reads all device traffic, is the ONLY account allowed to send commands.
user backend
topic read pipeline/v1/+/telemetry
topic read pipeline/v1/+/status
topic read pipeline/v1/+/ack
topic write pipeline/v1/+/cmd

# Read-only monitoring account (contract monitor, attack demos as an observer).
user monitor
topic read pipeline/v1/#

${redteam ? `# LAB ONLY - attack demonstrations (compromised privileged account). Remove in production.
user redteam
topic readwrite pipeline/v1/#

` : ''}# Devices: %u = authenticated username = device id. A device can only publish
# its own telemetry/status/ack and only receive its own commands.
pattern write pipeline/v1/%u/telemetry
pattern write pipeline/v1/%u/status
pattern write pipeline/v1/%u/ack
pattern read pipeline/v1/%u/cmd
`,
  0o644,
);

// ------------------------------------------------------------ device keys
const keys = Object.fromEntries(DEVICE_IDS.map((d) => [d, randomBytes(32).toString('hex')]));
// 0644: read by the backend container's unprivileged user. Lab setting - in production
// use Docker secrets or a vault, and per-device keys in the ESP32-S3 eFuse (HMAC peripheral).
write('device-keys.json', JSON.stringify(keys, null, 2), 0o644);

// ------------------------------------------------------------ env files
write(
  'backend.env',
  [
    'SECURITY_MODE=secure',
    'MQTT_USERNAME=backend',
    `MQTT_PASSWORD=${mqtt.backend}`,
    'MQTT_CA_FILE=/run/secrets/twin/ca.crt',
    'DEVICE_KEYS_FILE=/run/secrets/twin/device-keys.json',
    'INITIAL_USERS_FILE=/run/secrets/twin/initial-users.json',
    `JWT_SECRET=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'),
);
write(
  'emulator.env',
  [
    'SECURITY_MODE=secure',
    'MQTT_CA_FILE=/run/secrets/twin/ca.crt',
    'EMU_KEYS_FILE=/run/secrets/twin/device-keys.json',
    `MQTT_USER_NODE_INLET=node-inlet`,
    `MQTT_PASS_NODE_INLET=${mqtt['node-inlet']}`,
    `MQTT_USER_NODE_DOWNSTREAM=node-downstream`,
    `MQTT_PASS_NODE_DOWNSTREAM=${mqtt['node-downstream']}`,
    '',
  ].join('\n'),
);

// ------------------------------------------------------------ dashboard users
const users = { admin: secret(9), operator: secret(9), viewer: secret(9) };
write('initial-users.json', JSON.stringify(users, null, 2), 0o644);

console.log(`
Done. Initial dashboard accounts (change them after the first login):
  admin    / ${users.admin}
  operator / ${users.operator}
  viewer   / ${users.viewer}
Broker certificate valid for: ${sans.join(', ')}
`);
