/**
 * Live pipeline schematic (SVG). Mirrors the physical rig:
 *   reservoir -> pump -> P1 F1 --- segment A --- P2 --- segment B --- P3 F2 -> outlet -> reservoir
 *
 * - Segment colour = twin state of that segment (Phase 4), or the segment of
 *   an open leak/theft alert. Normal = blue, warning = amber, leak = red, theft = purple.
 * - Flow animation speed follows the measured flow.
 * - A marker shows the estimated leak/theft position when the twin provides it.
 */
import { DEFAULT_TOPOLOGY } from '@twin/contracts/devices';
import { useLive } from '../lib/store';
import type { Alert, SensorId } from '../lib/types';

const X0 = 190; // x of P1 (position 0 m)
const X1 = 840; // x of P3
const posM = DEFAULT_TOPOLOGY.positionsM;
const xOf = (m: number) => X0 + ((m - posM.P1) / (posM.P3 - posM.P1)) * (X1 - X0);
const PIPE_Y = 170;

const COLORS: Record<string, string> = {
  normal: 'var(--pipe-normal)',
  warning: 'var(--warn)',
  leak: 'var(--danger)',
  theft: 'var(--theft)',
  unknown: 'var(--muted)',
  off: 'var(--pipe-off)',
};

function segmentStates(alerts: Alert[], twin: ReturnType<typeof useTwin>): Record<'A' | 'B', string> {
  const s: Record<'A' | 'B', string> = {
    A: twin?.segments?.A?.state ?? 'normal',
    B: twin?.segments?.B?.state ?? 'normal',
  };
  for (const a of alerts) {
    if ((a.type === 'leak' || a.type === 'theft') && (a.segment === 'A' || a.segment === 'B')) s[a.segment] = a.type;
  }
  return s;
}
const useTwin = () => useLive((s) => s.twin);

export function PipelineSchematic() {
  const latest = useLive((s) => s.latest);
  const devices = useLive((s) => s.devices);
  const alerts = Object.values(useLive((s) => s.alerts));
  const twin = useTwin();
  const inlet = latest['node-inlet'];
  const down = latest['node-downstream'];
  const val = (id: SensorId) => (id === 'P1' || id === 'F1' ? inlet : down)?.sensors[id];
  const pumpOn = inlet?.pump?.on ?? false;
  const f1 = val('F1')?.v ?? 0;
  const f2 = val('F2')?.v ?? 0;
  const seg = segmentStates(alerts, twin);
  const flowing = pumpOn && f1 > 0.2;
  const speed = flowing ? Math.max(0.3, 3 / Math.max(f1, 0.1)) : 0; // seconds per dash cycle

  const markers = alerts
    .filter((a) => (a.type === 'leak' || a.type === 'theft') && typeof a.data?.positionM === 'number')
    .map((a) => ({ id: a.id, type: a.type, x: xOf(a.data!.positionM as number) }));
  // Filtered loss from the twin (4-s pulse windows) is far less noisy than F1-F2 of single samples.
  const twinLoss = (twin?.loss as { lpm?: number } | null)?.lpm;

  const online = (id: 'node-inlet' | 'node-downstream') => devices[id]?.online ?? latest[id] !== undefined;

  const sensorBox = (id: SensorId, x: number, above: boolean) => {
    const r = val(id);
    const unit = id.startsWith('P') ? 'bar' : 'L/min';
    const bad = r && r.q !== 'ok';
    const y = above ? PIPE_Y - 70 : PIPE_Y + 30;
    return (
      <g key={id}>
        <line x1={x} y1={PIPE_Y} x2={x} y2={above ? y + 40 : y} className="tap-line" />
        <circle cx={x} cy={PIPE_Y} r={7} className={`sensor-dot ${id.startsWith('P') ? 'p' : 'f'} ${bad ? 'bad' : ''}`} />
        <rect x={x - 46} y={y} width={92} height={40} rx={6} className={`sensor-box ${bad ? 'bad' : ''}`} />
        <text x={x} y={y + 15} className="sensor-id">{id}</text>
        <text x={x} y={y + 32} className="sensor-val">
          {r?.v === null || r?.v === undefined ? (bad ? r?.q : '--') : `${r.v.toFixed(2)} ${unit}`}
        </text>
      </g>
    );
  };

  return (
    <div className="card schematic">
      <div className="card-title">
        Pipeline twin
        <span className="legend">
          <i style={{ background: COLORS.normal }} /> normal <i style={{ background: COLORS.warning }} /> suspect
          <i style={{ background: COLORS.leak }} /> leak <i style={{ background: COLORS.theft }} /> theft
        </span>
      </div>
      <svg viewBox="0 0 1000 300" role="img" aria-label="Pipeline schematic">
        {/* device enclosures */}
        <rect x={95} y={20} width={210} height={250} rx={10} className={`device-box ${online('node-inlet') ? '' : 'offline'}`} />
        <text x={105} y={40} className="device-label">ESP32 #1 · node-inlet {online('node-inlet') ? '●' : '○ offline'}</text>
        <rect x={xOf(posM.P2) - 60} y={20} width={xOf(posM.F2) - xOf(posM.P2) + 120} height={250} rx={10} className={`device-box ${online('node-downstream') ? '' : 'offline'}`} />
        <text x={xOf(posM.P2) - 50} y={40} className="device-label">ESP32 #2 · node-downstream {online('node-downstream') ? '●' : '○ offline'}</text>

        {/* reservoir and return line */}
        <rect x={20} y={PIPE_Y - 30} width={50} height={70} rx={4} className="tank" />
        <rect x={22} y={PIPE_Y - 5} width={46} height={43} className="water" />
        <path d={`M 70 ${PIPE_Y} H 120`} className="pipe" style={{ stroke: pumpOn ? COLORS.normal : COLORS.off }} />
        <path d={`M 960 ${PIPE_Y} V 285 H 45 V ${PIPE_Y + 40}`} className="pipe return" />

        {/* pump */}
        <circle cx={140} cy={PIPE_Y} r={22} className={`pump ${pumpOn ? 'on' : ''}`} />
        <path d={`M 130 ${PIPE_Y - 10} L 154 ${PIPE_Y} L 130 ${PIPE_Y + 10} Z`} className="pump-arrow" />
        <text x={140} y={PIPE_Y + 45} className="small-label">pump {pumpOn ? `ON ${inlet?.pump?.duty ?? ''}%` : 'OFF'}</text>

        {/* pipe sections */}
        <path d={`M 162 ${PIPE_Y} H ${X0}`} className="pipe" style={{ stroke: pumpOn ? COLORS.normal : COLORS.off }} />
        <path d={`M ${X0} ${PIPE_Y} H ${xOf(posM.P2)}`} className="pipe" style={{ stroke: pumpOn ? COLORS[seg.A] : COLORS.off }} />
        <path d={`M ${xOf(posM.P2)} ${PIPE_Y} H ${X1}`} className="pipe" style={{ stroke: pumpOn ? COLORS[seg.B] : COLORS.off }} />
        <path d={`M ${X1} ${PIPE_Y} H 960`} className="pipe" style={{ stroke: pumpOn ? COLORS.normal : COLORS.off }} />
        {flowing && <path d={`M 162 ${PIPE_Y} H 960`} className="flow-anim" style={{ animationDuration: `${speed}s` }} />}

        {/* segment labels */}
        <text x={(X0 + xOf(posM.P2)) / 2} y={PIPE_Y - 16} className="seg-label">segment A</text>
        <text x={(xOf(posM.P2) + X1) / 2} y={PIPE_Y - 16} className="seg-label">segment B</text>

        {/* outlet valve */}
        <path d={`M 900 ${PIPE_Y - 12} L 920 ${PIPE_Y + 12} L 920 ${PIPE_Y - 12} L 900 ${PIPE_Y + 12} Z`} className="valve" />
        <text x={910} y={PIPE_Y + 45} className="small-label">outlet</text>

        {/* sensors */}
        {sensorBox('P1', xOf(posM.P1), true)}
        {sensorBox('F1', xOf(posM.F1) + 30, false)}
        {sensorBox('P2', xOf(posM.P2), true)}
        {sensorBox('P3', xOf(posM.P3), true)}
        {sensorBox('F2', xOf(posM.F2) + 30, false)}

        {/* estimated leak / theft position */}
        {markers.map((m) => (
          <g key={m.id} className={`marker ${m.type}`}>
            <path d={`M ${m.x} ${PIPE_Y + 8} q -9 16 0 24 q 9 -8 0 -24 Z`} />
            <text x={m.x} y={PIPE_Y + 52} className="marker-label">{m.type === 'leak' ? 'leak?' : 'theft?'}</text>
          </g>
        ))}

        {/* mass balance readout */}
        <text x={(X0 + X1) / 2} y={PIPE_Y + 100} className="balance">
          {twinLoss !== undefined ? `twin mass balance: loss = ${twinLoss.toFixed(2)} L/min` : `ΔQ = F1 − F2 = ${(f1 - f2).toFixed(2)} L/min`}
        </text>
      </svg>
    </div>
  );
}
