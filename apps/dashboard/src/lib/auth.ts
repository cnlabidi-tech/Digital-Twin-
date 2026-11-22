/** Login state. The JWT is kept in localStorage and sent as a Bearer token (and ?token= for the WebSocket). */
import { useEffect, useState } from 'react';

export type Role = 'viewer' | 'operator' | 'admin';
export interface Me {
  username: string;
  role: Role;
  loginRequired: boolean;
}
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const atLeast = (me: Me | null, r: Role) => !!me && RANK[me.role] >= RANK[r];

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'login failed');
  localStorage.setItem('twin.token', body.token);
}

export function logout(): void {
  localStorage.removeItem('twin.token');
  location.reload();
}

/** Current user, or null while unknown / not logged in. */
export function useMe(): { me: Me | null; needLogin: boolean; refresh: () => void } {
  const [me, setMe] = useState<Me | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    const token = localStorage.getItem('twin.token');
    fetch('/api/auth/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => {
        if (r.ok) {
          setMe(await r.json());
          setNeedLogin(false);
        } else {
          localStorage.removeItem('twin.token');
          setNeedLogin(true);
        }
      })
      .catch(() => setNeedLogin(false));
    const onUnauth = () => setNeedLogin(true);
    window.addEventListener('twin:unauthorized', onUnauth);
    return () => window.removeEventListener('twin:unauthorized', onUnauth);
  }, [n]);
  return { me, needLogin, refresh: () => setN((x) => x + 1) };
}
