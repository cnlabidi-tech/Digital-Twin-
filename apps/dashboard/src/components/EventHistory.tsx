/** Event history: live-updated timeline with a kind filter. */
import { useState } from 'react';
import { useLive } from '../lib/store';

const KINDS = ['all', 'alert', 'device', 'security', 'command', 'system'] as const;

export function EventHistory() {
  const events = useLive((s) => s.events);
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all');
  const shown = (kind === 'all' ? events : events.filter((e) => e.kind === kind)).slice(0, 200);

  return (
    <div className="card events">
      <div className="card-title">
        Event history
        <div className="seg-control">
          {KINDS.map((k) => (
            <button key={k} className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Time</th><th>Kind</th><th>Device</th><th>Message</th></tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={`${e.id}-${e.time}`} className={e.severity}>
                <td className="mono">{new Date(e.time).toLocaleTimeString()}</td>
                <td><span className={`kind ${e.kind}`}>{e.kind}</span></td>
                <td className="mono">{e.device_id ?? ''}</td>
                <td>{e.message}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={4} className="empty">No events yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
