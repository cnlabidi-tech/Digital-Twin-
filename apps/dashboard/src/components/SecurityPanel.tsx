/**
 * Security panel (Phase 6): which defences are active, what the security
 * gate rejected (by reason), and - for admins - the tamper-evident audit log.
 */
import { useEffect, useState } from 'react';
import { getJson } from '../lib/api';

interface Status {
  mode: string;
  signaturesRequired: boolean;
  loginRequired: boolean;
  mqttTls: boolean;
  gate: { checked: number; rejected: Record<string, number> };
  rejected: Record<string, number>;
}
interface AuditRow { id: number; time: string; actor: string; action: string; target: string | null; result: string }

export function SecurityPanel({ isAdmin }: { isAdmin: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [verify, setVerify] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      getJson<Status>('/api/security/status').then((s) => alive && setSt(s)).catch(() => undefined);
      if (isAdmin) getJson<AuditRow[]>('/api/audit?limit=12').then((a) => alive && setAudit(a)).catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [isAdmin]);

  const runVerify = async () => {
    const r = await getJson<{ ok: boolean; rows: number; brokenAt?: number }>('/api/audit/verify');
    setVerify(r.ok ? `✓ chain intact (${r.rows} entries)` : `✗ chain BROKEN at entry #${r.brokenAt}`);
  };

  if (!st) return null;
  const rejected = Object.entries(st.rejected).sort((a, b) => b[1] - a[1]);
  const flag = (on: boolean, label: string) => <span className={`tag ${on ? 'okbg' : 'warnbg'}`}>{on ? '✓' : '✗'} {label}</span>;

  return (
    <div className="card security">
      <div className="card-title">Security <span className="tag">{st.mode} mode</span></div>
      <div className="row">
        {flag(st.mqttTls, 'MQTT TLS')}
        {flag(st.signaturesRequired, 'signed messages')}
        {flag(st.loginRequired, 'login + roles')}
      </div>
      <div className="sub">Rejected device traffic ({st.gate.checked} checked)</div>
      {!rejected.length && <div className="empty">nothing rejected</div>}
      <table className="compact">
        <tbody>
          {rejected.map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td className="num">{v}</td></tr>)}
        </tbody>
      </table>
      {isAdmin && (
        <>
          <div className="sub row">Audit log <button className="btn small ghost" onClick={runVerify}>verify chain</button></div>
          {verify && <div className={verify.startsWith('✓') ? 'okline' : 'error'}>{verify}</div>}
          <ul className="cmdlog">
            {audit.map((a) => (
              <li key={a.id}>
                <span className={`chip ${a.result === 'ok' ? 'ok' : 'bad'}`}>{a.result}</span>
                <span className="cmd-main">{a.action}{a.target ? ` ${a.target}` : ''}</span>
                <span className="cmd-meta">#{a.id} · {a.actor} · {new Date(a.time).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
