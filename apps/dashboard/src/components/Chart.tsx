/**
 * Thin React wrapper around uPlot (fast canvas time-series charts: thousands
 * of points redrawn several times per second at negligible CPU cost).
 */
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface ChartSeries {
  label: string;
  color: string;
  dash?: number[];
}

interface Props {
  title: string;
  unit: string;
  series: ChartSeries[];
  /** [x(seconds), y1, y2, ...] aligned arrays */
  data: uPlot.AlignedData;
  /** visible window in seconds (live mode); undefined = fit all data */
  windowS?: number;
  height?: number;
  yRange?: [number, number];
}

export function Chart({ title, unit, series, data, windowS, height = 200, yRange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  // create once per series layout
  useEffect(() => {
    if (!host.current) return;
    const opts: uPlot.Options = {
      width: host.current.clientWidth,
      height,
      legend: { live: true },
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: true }, y: yRange ? { range: yRange } : { auto: true } },
      axes: [
        { stroke: '#94a3b8', grid: { stroke: 'rgba(148,163,184,0.12)' }, ticks: { stroke: 'rgba(148,163,184,0.2)' } },
        { stroke: '#94a3b8', grid: { stroke: 'rgba(148,163,184,0.12)' }, label: unit, size: 55 },
      ],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: 1.6, dash: s.dash, spanGaps: false }))],
    };
    plot.current = new uPlot(opts, data, host.current);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: host.current!.clientWidth, height }));
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.map((s) => s.label).join(','), height]);

  // push new data
  useEffect(() => {
    const p = plot.current;
    if (!p) return;
    p.setData(data, windowS === undefined);
    if (windowS !== undefined) {
      const xs = data[0] as number[];
      const max = xs.length ? xs[xs.length - 1]! : Date.now() / 1000;
      p.setScale('x', { min: max - windowS, max });
    }
  }, [data, windowS]);

  return (
    <div className="chart">
      <div className="chart-title">{title}</div>
      <div ref={host} />
    </div>
  );
}

/**
 * Merge several independent series (each with its own timestamps) onto one
 * x axis, as uPlot requires. Telemetry from the two devices arrives at
 * slightly different instants, so values are aligned to 0.1 s buckets.
 */
export function align(seriesList: Array<{ t: number[]; v: (number | null)[] }>): uPlot.AlignedData {
  const map = new Map<number, (number | null)[]>();
  seriesList.forEach((s, i) => {
    for (let k = 0; k < s.t.length; k++) {
      const x = Math.round(s.t[k]! * 10) / 10;
      let row = map.get(x);
      if (!row) map.set(x, (row = new Array(seriesList.length).fill(null)));
      row[i] = s.v[k] ?? null;
    }
  });
  const xs = [...map.keys()].sort((a, b) => a - b);
  return [xs, ...seriesList.map((_, i) => xs.map((x) => map.get(x)![i] ?? null))] as uPlot.AlignedData;
}
