/** Open alerts, most severe first, with acknowledge action. */
import { useState } from 'react';
import { postJson } from '../lib/api';
import { useLive } from '../lib/store';
import type { Alert } from '../lib/types';

const SEV_RANK = { critical: 0, warning: 1, info: 2 } as const;
const ICON: Record<Alert['type'], string> = {
  leak: '💧', theft: '⚠', fdi: '🛡', sensor_fault: '🔧', device_offline: '📡', security: '🔒', model: '📈',
};

export function AlertsPanel({ canAck = true }: { canAck?: boolean }) {
  const alerts = Object.values(useLive((s) => s.alerts)).sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.updated_at.localeCompare(a.updated_at),
  );
  const [err, setErr] = useState<string | null>(null);

  const ack = async (id: number) => {
    try {
      setErr(null);
      await postJson(`/api/alerts/${id}/ack`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card alerts">
      <div className="card-title">
        Alerts <span className={`count ${alerts.length ? 'hot' : ''}`}>{alerts.length}</span>
      </div>
      {err && <div className="error">{err}</div>}
      {!alerts.length && <div className="empty">No active alert. All physical and security checks pass.</div>}
      <ul>
        {alerts.map((a) => (
          <li key={a.id} className={`alert ${a.severity} ${a.state}`}>
            <span className="alert-icon">{ICON[a.type] ?? '!'}</span>
            <div className="alert-body">
              <div className="alert-head">
                <b>{a.type.replace('_', ' ')}</b>
                {a.segment && <span className="tag">segment {a.segment}</span>}
                <span className="time">{new Date(a.created_at).toLocaleTimeString()}</span>
              </div>
              <div className="alert-msg">{a.message}</div>
              {a.state === 'acknowledged' && <div className="ack-by">acknowledged by {a.acknowledged_by}</div>}
            </div>
            {a.state === 'active' && canAck && (
              <button className="btn small" onClick={() => ack(a.id)}>Ack</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
