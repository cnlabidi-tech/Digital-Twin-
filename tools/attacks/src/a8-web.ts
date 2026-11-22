/**
 * A8 - Attacks on the dashboard / REST API.
 *  a) API call without a token                       -> 401
 *  b) viewer tries to stop the pump                  -> 403 (role check), audited
 *  c) token forged: payload changed to role=admin    -> 401 (JWT signature)
 *  d) password brute force                           -> 429 after 5 failures
 *  e) WebSocket without a token                      -> closed with 4401
 */
import { API, report, runIfMain, secret, title } from './lib';

export async function main(): Promise<void> {
  title('A8  Web / API attacks');
  const users = secret('initial-users.json');
  const login = async (u: string, p: string) =>
    fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });

  const r1 = await fetch(`${API}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'node-inlet', type: 'pump.set', params: { on: false } }) });
  report('Send a command without logging in', 'JWT required on every API route', r1.status === 401, `HTTP ${r1.status}`);

  const viewer = (await (await login('viewer', users.viewer!)).json()) as { token: string };
  const r2 = await fetch(`${API}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewer.token}` },
    body: JSON.stringify({ deviceId: 'node-inlet', type: 'pump.set', params: { on: false } }),
  });
  report('Viewer account tries to stop the pump', 'role-based access control (operator required)', r2.status === 403, `HTTP ${r2.status} (attempt recorded in the audit log)`);

  const [h, p, s] = viewer.token.split('.');
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url')}.${s}`;
  const r3 = await fetch(`${API}/api/audit`, { headers: { Authorization: `Bearer ${forged}` } });
  report('Viewer token edited to role=admin', 'JWT HMAC signature', r3.status === 401, `HTTP ${r3.status}`);

  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await login('operator', `wrong-${i}`)).status);
  report('Password brute force on "operator"', 'lock-out after 5 failures (5 min)', codes.includes(429), `responses: ${codes.join(' ')}`);

  const wsUrl = API.replace(/^http/, 'ws') + '/ws';
  const code = await new Promise<number>((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.onclose = (e) => resolve(e.code);
    setTimeout(() => resolve(-1), 3000);
  });
  report('Open the live WebSocket without a token', 'token check on WebSocket upgrade', code === 4401, `closed with code ${code}`);
}

runIfMain(import.meta, main);
