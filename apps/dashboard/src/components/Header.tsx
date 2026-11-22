/** Top bar: overall system state, link status, device status. */
import type { ReactNode } from 'react';
import { useLive } from '../lib/store';
import type { Alert } from '../lib/types';

function overall(alerts: Alert[]): { label: string; cls: string } {
  const has = (t: Alert['type']) => alerts.some((a) => a.type === t);
  if (has('leak')) return { label: 'LEAK DETECTED', cls: 'danger' };
  if (has('theft')) return { label: 'THEFT SUSPECTED', cls: 'theft' };
  if (has('fdi') || has('security')) return { label: 'UNDER ATTACK', cls: 'danger' };
  if (alerts.some((a) => a.severity === 'critical')) return { label: 'CRITICAL', cls: 'danger' };
  if (alerts.length) return { label: 'WARNING', cls: 'warn' };
  return { label: 'NORMAL', cls: 'ok' };
}

export function Header({ right }: { right?: ReactNode }) {
  const connected = useLive((s) => s.connected);
  const alerts = Object.values(useLive((s) => s.alerts));
  const latest = useLive((s) => s.latest);
  const devices = useLive((s) => s.devices);
  const st = overall(alerts);
  const now = Date.now();

  const dev = (id: 'node-inlet' | 'node-downstream') => {
    const t = latest[id];
    const fresh = t && now - t.receivedAt < 5000;
    const on = (devices[id]?.online ?? true) && fresh;
    return (
      <span className={`pill ${on ? 'ok' : 'bad'}`} title={t ? `seq ${t.seq}, RSSI ${t.rssi} dBm` : 'no data'}>
        {id} {on ? '●' : '○'}
      </span>
    );
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" /> Pipeline Digital Twin
      </div>
      <div className={`state ${st.cls}`}>{st.label}</div>
      <div className="pills">
        {dev('node-inlet')}
        {dev('node-downstream')}
        <span className={`pill ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'reconnecting…'}</span>
        {right}
      </div>
    </header>
  );
}
