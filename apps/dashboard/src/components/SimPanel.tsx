/**
 * Simulation panel - talks to the DEVICE EMULATOR's control API, not to the
 * twin. Used during development and for the defence demo to create leaks,
 * theft and attacks on demand. Hidden automatically when no emulator runs
 * (real hardware), so it can never be confused with a twin feature.
 */
import { useEffect, useState } from 'react';
import { emu } from '../lib/api';

interface EmuState {
  taps: Array<{ id: string; kind: string; positionM: number; opening: number }>;
  faults: Array<{ id: string; sensor: string; type: string }>;
  attacks: Array<{ id: string; type: string; device: string; sensor?: string }>;
  truth: { outletOpening: number; tapFlows: Record<string, number> };
}

const ACTIONS: Array<{ group: string; items: Array<[string, string, string, unknown?]> }> = [
  { group: 'Hydraulic', items: [
    ['Leak A 0.5', '/api/leak', 'POST', { segment: 'A', rateLpm: 0.5 }],
    ['Leak B 0.5', '/api/leak', 'POST', { segment: 'B', rateLpm: 0.5 }],
    ['Small leak B', '/api/leak', 'POST', { segment: 'B', fraction: 0.3, rateLpm: 0.15 }],
    ['Theft B', '/api/theft', 'POST', { segment: 'B', fraction: 0.6, rateLpm: 0.9, rampS: 10 }],
    ['Valve 60 %', '/api/valve', 'POST', { outletOpening: 0.6 }],
    ['Valve 100 %', '/api/valve', 'POST', { outletOpening: 1 }],
  ] },
  { group: 'Sensor faults', items: [
    ['P2 stuck', '/api/faults', 'POST', { sensor: 'P2', type: 'stuck' }],
    ['P3 unplugged', '/api/faults', 'POST', { sensor: 'P3', type: 'disconnected' }],
    ['P1 drift', '/api/faults', 'POST', { sensor: 'P1', type: 'drift', magnitude: 0.5 }],
  ] },
  { group: 'FDI (compromised node)', items: [
    ['F1 +0.6', '/api/attacks', 'POST', { type: 'fdi_bias', sensor: 'F1', delta: 0.6 }],
    ['Replay downstream', '/api/attacks', 'POST', { type: 'fdi_replay', device: 'node-downstream', recordS: 20 }],
    ['P2 freeze', '/api/attacks', 'POST', { type: 'fdi_freeze', sensor: 'P2' }],
    ['F2 ramp', '/api/attacks', 'POST', { type: 'fdi_ramp', sensor: 'F2', ratePerS: 0.01 }],
  ] },
  { group: 'Network attacks', items: [
    ['Tamper F2', '/api/attacks', 'POST', { type: 'tamper', sensor: 'F2', delta: 0.5 }],
    ['Replay msgs', '/api/attacks', 'POST', { type: 'replay', device: 'node-downstream', recordS: 10 }],
    ['Spoof inlet', '/api/attacks', 'POST', { type: 'spoof', device: 'node-inlet' }],
    ['Drop downstream', '/api/attacks', 'POST', { type: 'drop', device: 'node-downstream' }],
    ['Downstream offline 20 s', '/api/devices/node-downstream/offline', 'POST', { seconds: 20 }],
  ] },
];

export function SimPanel() {
  const [st, setSt] = useState<EmuState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    const poll = () => emu<EmuState>('/api/state').then((s) => alive && setSt(s)).catch(() => alive && setSt(null));
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!st) return null; // no emulator: real hardware mode

  const run = async (path: string, method: string, body?: unknown) => {
    try {
      setErr(null);
      await emu(path, method, body);
      setSt(await emu<EmuState>('/api/state'));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const active = [
    ...st.taps.map((t) => ({ id: t.id, label: `${t.kind} @ ${t.positionM.toFixed(2)} m (${(st.truth.tapFlows[t.id] ?? 0).toFixed(2)} L/min)`, path: `/api/taps/${t.id}` })),
    ...st.faults.map((f) => ({ id: f.id, label: `fault ${f.type} ${f.sensor}`, path: `/api/faults/${f.id}` })),
    ...st.attacks.map((a) => ({ id: a.id, label: `attack ${a.type} ${a.sensor ?? a.device}`, path: `/api/attacks/${a.id}` })),
  ];

  return (
    <div className="card sim">
      <div className="card-title">
        Simulation <span className="tag warnbg">emulator · dev only</span>
        <button className="btn small ghost" onClick={() => setOpen(!open)}>{open ? 'hide' : 'show'}</button>
      </div>
      {open && (
        <>
          {err && <div className="error">{err}</div>}
          {ACTIONS.map((g) => (
            <div key={g.group} className="sim-group">
              <div className="sim-group-title">{g.group}</div>
              <div className="sim-buttons">
                {g.items.map(([label, path, method, body]) => (
                  <button key={label} className="btn small" onClick={() => run(path, method, body)}>{label}</button>
                ))}
              </div>
            </div>
          ))}
          <div className="sim-group">
            <div className="sim-group-title">Active injections (ground truth, invisible to the twin)</div>
            {!active.length && <div className="empty">none · outlet valve {Math.round(st.truth.outletOpening * 100)} %</div>}
            {active.map((a) => (
              <div key={a.id} className="sim-active">
                <span>{a.label}</span>
                <button className="btn small ghost" onClick={() => run(a.path, 'DELETE')}>stop</button>
              </div>
            ))}
            <button className="btn small danger" onClick={() => run('/api/reset', 'POST')}>Reset all</button>
          </div>
        </>
      )}
    </div>
  );
}
