/**
 * Control panel (Phase 5): the twin -> physical direction.
 * Manual pump control, telemetry rate, ping, automatic-stop policy and a live
 * command log showing each command's life cycle (sent -> executed/rejected/
 * timeout, round-trip latency, effect verified in telemetry).
 */
import { useEffect, useState } from 'react';
import { ApiError, getJson, postJson, api } from '../lib/api';
import { useLive } from '../lib/store';
import type { CommandUpdate, DeviceId } from '../lib/types';

interface Policy { autoStopOnLeak: boolean; autoStopOnTheft: boolean }
type Row = { cmd_id: string; device_id: DeviceId; type: string; params: unknown; status: string; issued_by: string; reason: string | null; latency_ms: number | null; verified: boolean; created_at: string };

const STATUS_CLASS: Record<string, string> = { executed: 'ok', sent: 'info', pending: 'info', rejected: 'bad', timeout: 'bad' };

export function ControlPanel({ canControl = true, canPolicy = true }: { canControl?: boolean; canPolicy?: boolean }) {
  const latest = useLive((s) => s.latest);
  const live = useLive((s) => s.commands);
  const [history, setHistory] = useState<CommandUpdate[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [duty, setDuty] = useState(100);
  const [err, setErr] = useState<string | null>(null);
  const pump = latest['node-inlet']?.pump;

  useEffect(() => {
    getJson<Policy>('/api/control/policy').then(setPolicy).catch(() => undefined);
    getJson<Row[]>('/api/commands?limit=20')
      .then((rows) => setHistory(rows.map((r) => ({
        cmdId: r.cmd_id, deviceId: r.device_id, type: r.type, params: r.params, status: r.status, issuedBy: r.issued_by,
        reason: r.reason ?? undefined, latencyMs: r.latency_ms ?? undefined, verified: r.verified, createdAt: new Date(r.created_at).getTime(),
      }))))
      .catch(() => undefined);
  }, []);

  const send = async (deviceId: DeviceId, type: string, params: unknown = {}, force = false) => {
    setErr(null);
    try {
      await postJson('/api/commands', { deviceId, type, params, force });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && confirm(`${e.message}\n\nOverride the interlock?`)) {
        return send(deviceId, type, params, true);
      }
      setErr((e as Error).message);
    }
  };

  const togglePolicy = async (k: keyof Policy) => {
    if (!policy) return;
    try {
      setPolicy(await api<Policy>('/api/control/policy', { method: 'PUT', body: JSON.stringify({ [k]: !policy[k] }) }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const merged = [...live, ...history.filter((h) => !live.some((l) => l.cmdId === h.cmdId))].slice(0, 15);

  return (
    <div className="card control">
      <div className="card-title">
        Control
        <span className={`tag ${pump?.on ? 'okbg' : ''}`}>pump {pump ? (pump.on ? `ON ${pump.duty}%` : 'OFF') : '?'}</span>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={!canControl} onClick={() => send('node-inlet', 'pump.set', { on: true, duty })}>Start pump</button>
        <button className="btn danger" disabled={!canControl} onClick={() => send('node-inlet', 'pump.set', { on: false })}>Stop pump</button>
      </div>
      <label className="field">
        PWM duty: {duty} %
        <input type="range" min={30} max={100} step={5} value={duty} disabled={!canControl} onChange={(e) => setDuty(Number(e.target.value))}
          onMouseUp={() => pump?.on && send('node-inlet', 'pump.set', { on: true, duty })} />
      </label>
      <div className="row">
        <button className="btn small" disabled={!canControl} onClick={() => send('node-inlet', 'ping')}>Ping inlet</button>
        <button className="btn small" disabled={!canControl} onClick={() => send('node-downstream', 'ping')}>Ping downstream</button>
        <button className="btn small" disabled={!canControl} onClick={() => { send('node-inlet', 'telemetry.set_interval', { intervalMs: 500 }); send('node-downstream', 'telemetry.set_interval', { intervalMs: 500 }); }}>Rate 2 Hz</button>
        <button className="btn small" disabled={!canControl} onClick={() => { send('node-inlet', 'telemetry.set_interval', { intervalMs: 1000 }); send('node-downstream', 'telemetry.set_interval', { intervalMs: 1000 }); }}>Rate 1 Hz</button>
      </div>

      {policy && (
        <div className="policy">
          <div className="sub">Automatic actions</div>
          <label><input type="checkbox" checked={policy.autoStopOnLeak} disabled={!canPolicy} onChange={() => togglePolicy('autoStopOnLeak')} /> stop pump on confirmed leak</label>
          <label><input type="checkbox" checked={policy.autoStopOnTheft} disabled={!canPolicy} onChange={() => togglePolicy('autoStopOnTheft')} /> stop pump on confirmed theft</label>
          <div className="hint">Blocked automatically while data integrity is in doubt.</div>
        </div>
      )}

      <div className="sub">Commands</div>
      <ul className="cmdlog">
        {merged.map((c) => (
          <li key={c.cmdId}>
            <span className={`chip ${STATUS_CLASS[c.status] ?? ''}`}>{c.status}</span>
            <span className="cmd-main">{c.type} {c.params && Object.keys(c.params as object).length ? JSON.stringify(c.params) : ''}</span>
            <span className="cmd-meta">
              {c.deviceId.replace('node-', '')} · {c.issuedBy}
              {typeof c.latencyMs === 'number' && ` · ${c.latencyMs} ms`}
              {c.verified && ' · ✓ verified'}
              {c.reason && ` · ${c.reason}`}
            </span>
          </li>
        ))}
        {!merged.length && <li className="empty">No command yet.</li>}
      </ul>
    </div>
  );
}
