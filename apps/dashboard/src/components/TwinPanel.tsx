/**
 * Twin panel: what the digital twin "thinks".
 *  - mode (learning / monitoring / transient / idle / stale)
 *  - expected vs measured values (the model's prediction)
 *  - residual z-scores with the violation threshold
 *  - mass-balance loss and CUSUM chart
 *  - diagnosis (healthy / loss / inconsistent + suspect sensors)
 */
import { useMemo, useState } from 'react';
import { postJson } from '../lib/api';
import { useLive } from '../lib/store';
import { align, Chart, type ChartSeries } from './Chart';

const Z_LIMIT = 5;
const LOSS_SERIES: ChartSeries[] = [{ label: 'loss F1−F2 (L/min)', color: '#f87171' }];
const CUSUM_SERIES: ChartSeries[] = [
  { label: 'CUSUM+ (loss)', color: '#fb923c' },
  { label: 'CUSUM− (gain)', color: '#60a5fa' },
];
const MODE_TEXT: Record<string, string> = {
  waiting: 'waiting for data',
  learning: 'learning healthy baseline',
  monitoring: 'monitoring',
  transient: 'operating change - detection paused',
  idle: 'pump stopped',
  stale: 'data missing / devices out of sync',
};

export function TwinPanel({ canRelearn = true }: { canRelearn?: boolean }) {
  const twin = useLive((s) => s.twin);
  const ts = useLive((s) => s.twinSeries);
  const version = useLive((s) => s.version);
  const [msg, setMsg] = useState<string | null>(null);
  const empty = { t: [], v: [] };
  const lossData = useMemo(() => align([ts.loss ?? empty]), [ts, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const cusData = useMemo(() => align([ts.cusumPos ?? empty, ts.cusumNeg ?? empty]), [ts, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!twin) return <div className="card"><div className="card-title">Digital twin</div><div className="empty">Waiting for the twin…</div></div>;

  const m = twin.measured as Record<string, number> | null;
  const e = twin.expected as Record<string, number> | null;
  const z = twin.z as Record<string, number> | null;
  const diag = twin.diagnosis as { hypothesis: string; suspects: string[]; reasons: string[] } | null;
  const learning = twin.learning as { progress: number; needed: number } | null;
  const cusum = twin.cusum as { pos: number; neg: number; h: number };
  const model = twin.model as Record<string, number> | null;
  const loc = twin.location as { segment: string; positionM: number } | null;

  const relearn = async () => {
    if (!confirm('Learn a new healthy baseline? Only do this when the pipe is known to be intact.')) return;
    try {
      await postJson('/api/twin/relearn');
      setMsg('Re-learning started');
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  const row = (label: string, meas?: number, exp?: number, unit = '') => (
    <tr key={label}>
      <td>{label}</td>
      <td className="num">{meas === undefined || !Number.isFinite(meas) ? '–' : meas.toFixed(3)}</td>
      <td className="num">{exp === undefined || !Number.isFinite(exp) ? '–' : exp.toFixed(3)}</td>
      <td className="num">{meas !== undefined && exp !== undefined && Number.isFinite(meas) && Number.isFinite(exp) ? (meas - exp).toFixed(3) : '–'}</td>
      <td className="unit">{unit}</td>
    </tr>
  );

  return (
    <div className="card twin">
      <div className="card-title">
        Digital twin
        <span className={`tag mode-${twin.mode}`}>{MODE_TEXT[twin.mode] ?? twin.mode}</span>
        {diag && (
          <span className={`tag diag-${diag.hypothesis}`}>
            {diag.hypothesis === 'healthy' ? 'physics consistent' : diag.hypothesis === 'loss' ? 'fluid loss' : `inconsistent data${diag.suspects.length ? ` · suspect ${diag.suspects.join(', ')}` : ''}`}
          </span>
        )}
        {canRelearn && <button className="btn small ghost" onClick={relearn}>Re-learn baseline</button>}
      </div>
      {msg && <div className="empty">{msg}</div>}
      {learning && (
        <div className="progress">
          <div style={{ width: `${(100 * learning.progress) / learning.needed}%` }} />
          <span>learning {learning.progress}/{learning.needed} samples (keep the pipe healthy and steady)</span>
        </div>
      )}

      <div className="twin-grid">
        <div>
          <div className="sub">Measured vs expected (model)</div>
          <table className="compact">
            <thead><tr><th /><th>measured</th><th>expected</th><th>residual</th><th /></tr></thead>
            <tbody>
              {row('P1 (pump curve)', m?.P1, e?.P1fromPump, 'bar')}
              {row('P2', m?.P2, e?.P2, 'bar')}
              {row('P3', m?.P3, e?.P3, 'bar')}
              {row('F2 (= F1 / c)', m?.F2, e?.F2, 'L/min')}
            </tbody>
          </table>
          {loc && (twin.loss as { detected?: boolean } | null)?.detected && (
            <div className="loc">
              Estimated position: <b>segment {loc.segment}</b>, {loc.positionM.toFixed(2)} m from P1
            </div>
          )}
          {diag && diag.reasons.length > 0 && <ul className="reasons">{diag.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
        <div>
          <div className="sub">Residuals (z = deviation / normal noise, limit ±{Z_LIMIT})</div>
          <div className="zbars">
            {z && Object.entries(z).map(([k, v]) => {
              const w = Math.min(Math.abs(v) / (2 * Z_LIMIT), 1) * 50;
              return (
                <div key={k} className="zrow">
                  <span className="zname">{k}</span>
                  <div className="zbar">
                    <div className="zmid" />
                    <div className="zlimit l" /><div className="zlimit r" />
                    <div className={`zfill ${Math.abs(v) > Z_LIMIT ? 'bad' : ''}`} style={v >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                  </div>
                  <span className="zval">{v.toFixed(1)}</span>
                </div>
              );
            })}
            {!z && <div className="empty">available after learning</div>}
          </div>
          {model && (
            <div className="model">
              model: RA={model.RA?.toFixed(4)} RB={model.RB?.toFixed(4)} Rout={model.RoutTracked?.toFixed(4)} c={model.c?.toFixed(3)} pump a={model.pumpA?.toFixed(2)} b={model.pumpB?.toFixed(3)}
              {' · '}CUSUM {cusum.pos.toFixed(1)}/{cusum.h}
            </div>
          )}
        </div>
      </div>
      <div className="twin-charts">
        <Chart title="Mass balance loss" unit="L/min" series={LOSS_SERIES} data={lossData as never} windowS={300} height={150} />
        <Chart title="CUSUM on mass residual (alarm at h)" unit="" series={CUSUM_SERIES} data={cusData as never} windowS={300} height={150} />
      </div>
    </div>
  );
}
