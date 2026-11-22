/**
 * Pressure and flow charts. Two modes:
 *   live    - rolling window fed by the WebSocket (1 / 5 / 15 / 30 min)
 *   history - any past range from TimescaleDB (bucketed averages)
 */
import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../lib/api';
import { useLive, type Series } from '../lib/store';
import type { SensorId } from '../lib/types';
import { align, Chart, type ChartSeries } from './Chart';

const P_SERIES: ChartSeries[] = [
  { label: 'P1', color: '#38bdf8' },
  { label: 'P2', color: '#a78bfa' },
  { label: 'P3', color: '#f472b6' },
];
const F_SERIES: ChartSeries[] = [
  { label: 'F1 (in)', color: '#34d399' },
  { label: 'F2 (out)', color: '#fbbf24' },
];

const WINDOWS = [60, 300, 900, 1800];
const HISTORY = [
  { label: '1 h', s: 3600, bucket: '5s' },
  { label: '6 h', s: 6 * 3600, bucket: '1m' },
  { label: '24 h', s: 24 * 3600, bucket: '1m' },
  { label: '7 d', s: 7 * 24 * 3600, bucket: '10m' },
];

type Row = { time: string; sensor_id: SensorId; value: number | null };

export function LiveCharts() {
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [windowS, setWindowS] = useState(300);
  const [hist, setHist] = useState(HISTORY[0]!);
  const [histData, setHistData] = useState<Record<SensorId, Series> | null>(null);
  const version = useLive((s) => s.version);
  const series = useLive((s) => s.series);

  useEffect(() => {
    if (mode !== 'history') return;
    const from = new Date(Date.now() - hist.s * 1000).toISOString();
    getJson<Row[]>(`/api/telemetry?bucket=${hist.bucket}&from=${from}&limit=100000`)
      .then((rows) => {
        const out = { P1: { t: [], v: [] }, P2: { t: [], v: [] }, P3: { t: [], v: [] }, F1: { t: [], v: [] }, F2: { t: [], v: [] } } as Record<SensorId, Series>;
        for (const r of rows) {
          out[r.sensor_id].t.push(new Date(r.time).getTime() / 1000);
          out[r.sensor_id].v.push(r.value === null ? null : Number(r.value));
        }
        setHistData(out);
      })
      .catch(() => setHistData(null));
  }, [mode, hist]);

  const src = mode === 'live' ? series : histData;
  // Re-align only when new data arrived (version changes once per frame at most).
  const pData = useMemo(() => (src ? align([src.P1, src.P2, src.P3]) : [[]]), [src, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const fData = useMemo(() => (src ? align([src.F1, src.F2]) : [[]]), [src, version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card">
      <div className="card-title">
        Measurements
        <div className="seg-control">
          <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live</button>
          <button className={mode === 'history' ? 'on' : ''} onClick={() => setMode('history')}>History</button>
          <span className="sep" />
          {mode === 'live'
            ? WINDOWS.map((w) => (
                <button key={w} className={w === windowS ? 'on' : ''} onClick={() => setWindowS(w)}>{w / 60} min</button>
              ))
            : HISTORY.map((h) => (
                <button key={h.label} className={h === hist ? 'on' : ''} onClick={() => setHist(h)}>{h.label}</button>
              ))}
        </div>
      </div>
      <Chart title="Pressure" unit="bar" series={P_SERIES} data={pData as never} windowS={mode === 'live' ? windowS : undefined} />
      <Chart title="Flow" unit="L/min" series={F_SERIES} data={fData as never} windowS={mode === 'live' ? windowS : undefined} />
    </div>
  );
}
