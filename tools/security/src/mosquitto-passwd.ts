/**
 * Mosquitto password-file hashing ("$7$" format of mosquitto 2.x):
 *   username:$7$<iterations>$<base64 salt>$<base64 PBKDF2-HMAC-SHA512(password, salt)>
 * Same result as the `mosquitto_passwd` tool, but cross-platform (no binary needed).
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';

export const ITERATIONS = 101;

export function mosquittoHash(password: string, salt = randomBytes(12), iterations = ITERATIONS): string {
  const hash = pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  return `$7$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function passwordFile(users: Record<string, string>): string {
  return Object.entries(users).map(([u, p]) => `${u}:${mosquittoHash(p)}`).join('\n') + '\n';
}
