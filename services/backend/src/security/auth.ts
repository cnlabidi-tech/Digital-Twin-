/**
 * Dashboard authentication and role-based access control.
 *
 *  - Passwords stored as scrypt hashes (memory-hard KDF, per-user salt).
 *  - Login returns a signed JWT (HS256, 8 h) carrying username + role.
 *  - Brute-force protection: 5 failed attempts per user+IP -> 5 min lock-out.
 *  - Roles:  viewer   read everything, live view
 *            operator + acknowledge alerts, send commands
 *            admin    + control policy, interlock override, re-learn, users, audit
 *  - Every login and every privileged action is written to the audit log.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { pool } from '../db/pool';
import type { AuditLog } from './audit';

export type Role = 'viewer' | 'operator' | 'admin';
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export interface User {
  username: string;
  role: Role;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: User;
    user: User;
  }
}

// ------------------------------------------------------------- passwords
const N = 16384, R = 8, P = 1;
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(expected, got);
}

/** Create the initial accounts from secrets/initial-users.json if the table is empty. */
export async function seedUsers(log: { info: (m: string) => void; warn: (m: string) => void }): Promise<void> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const f = config.security.initialUsersFile;
  if (!f || !existsSync(f)) {
    if (config.security.requireLogin) log.warn('no users and no initial-users.json: run npm run setup -w @twin/security');
    return;
  }
  const users = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>;
  for (const [username, pw] of Object.entries(users)) {
    const role: Role = username === 'admin' ? 'admin' : username === 'operator' ? 'operator' : 'viewer';
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)', [username, hashPassword(pw), role]);
  }
  log.info(`seeded ${Object.keys(users).length} initial users`);
}

// ------------------------------------------------------------- brute force
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;

// ------------------------------------------------------------- plugin
export async function authPlugin(app: FastifyInstance, opts: { audit: AuditLog }) {
  await app.register(jwt, { secret: config.security.jwtSecret, sign: { expiresIn: '8h' } });

  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const username = String(req.body?.username ?? '').slice(0, 64);
    const password = String(req.body?.password ?? '');
    const key = `${username}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.until > Date.now()) {
      await opts.audit.record({ actor: username, ip: req.ip, action: 'login', result: 'denied', details: { reason: 'locked_out' } });
      return reply.code(429).send({ error: 'too many failed attempts, try again later' });
    }
    const { rows } = await pool.query('SELECT username, password_hash, role, disabled FROM users WHERE username=$1', [username]);
    const u = rows[0];
    // Always run scrypt (even for unknown users) so timing does not reveal valid usernames.
    const ok = verifyPassword(password, u?.password_hash ?? hashPassword('x')) && u && !u.disabled;
    if (!ok) {
      // counter restarts only after a lock-out period has expired
      const n = (f && f.until && f.until <= Date.now() ? 0 : (f?.count ?? 0)) + 1;
      failures.set(key, { count: n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      await opts.audit.record({ actor: username || '?', ip: req.ip, action: 'login', result: 'denied', details: { failures: n } });
      return reply.code(401).send({ error: 'invalid username or password' });
    }
    failures.delete(key);
    await pool.query('UPDATE users SET last_login=now() WHERE username=$1', [username]);
    await opts.audit.record({ actor: username, role: u.role, ip: req.ip, action: 'login', result: 'ok' });
    const token = app.jwt.sign({ username, role: u.role });
    return { token, user: { username, role: u.role } };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!config.security.requireLogin) return { username: 'dev', role: 'admin', loginRequired: false };
    try {
      await req.jwtVerify();
      return { ...req.user, loginRequired: true };
    } catch {
      return reply.code(401).send({ error: 'not authenticated', loginRequired: true });
    }
  });
}

// Do not encapsulate: the JWT decorators (req.jwtVerify, app.jwt) must be
// visible to the whole application (same effect as the fastify-plugin helper).
(authPlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

/**
 * Global guard: every /api route needs a valid token (secure mode), except
 * login and health. Write routes need at least `operator`, some need `admin`
 * (declared with `config: { role: 'admin' }` on the route).
 */
export function installGuard(app: FastifyInstance, audit: AuditLog) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') || url === '/api/health' || url === '/api/auth/login' || url === '/api/auth/me') return;
    if (!config.security.requireLogin) {
      req.user = { username: 'dev', role: 'admin' };
      return;
    }
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const needed: Role =
      (req.routeOptions.config as { role?: Role } | undefined)?.role ?? (req.method === 'GET' ? 'viewer' : 'operator');
    if (ROLE_RANK[req.user.role] < ROLE_RANK[needed]) {
      await audit.record({ actor: req.user.username, role: req.user.role, ip: req.ip, action: `${req.method} ${url}`, result: 'denied', details: { needed } });
      return reply.code(403).send({ error: `requires role ${needed}` });
    }
  });
}

/** Verify a WebSocket token passed as ?token= (browsers cannot set headers on WebSocket). */
export function wsAuthorized(app: FastifyInstance, url: string | undefined): boolean {
  if (!config.security.requireLogin) return true;
  const token = new URL(url ?? '/', 'http://x').searchParams.get('token');
  if (!token) return false;
  try {
    app.jwt.verify(token);
    return true;
  } catch {
    return false;
  }
}
