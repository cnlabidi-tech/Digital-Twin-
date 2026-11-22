/** REST helpers. The auth token (Phase 6) is attached automatically when present. */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('twin.token');
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('twin:unauthorized'));
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  return body as T;
}

export const getJson = <T,>(path: string) => api<T>(path);
export const postJson = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Emulator control API (development / demo only). */
export const EMU_URL = (import.meta.env.VITE_EMU_URL as string | undefined) ?? 'http://localhost:4100';

export async function emu<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${EMU_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}
