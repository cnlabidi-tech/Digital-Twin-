/**
 * Offline evaluation (Monte Carlo, virtual time, fixed seed => reproducible).
 *
 *   npm run offline -w @twin/evaluation -- [--quick] [--seed 7]
 *
 * Campaigns:
 *   1. leaks   - random segment, position, size (0.05-1.2 L/min), operating point
 *   2. thefts  - valve opened over 6-15 s, 0.4-1.2 L/min
 *   3. normal  - hours of normal operation with valve / pump-speed changes and stops
 *   4. attacks - false data injection on every sensor + sensor faults
 * Metrics: detection rate, detection delay, false alarms per hour, localisation
 * error, leak-vs-theft accuracy, FDI detection, false shutdowns caused by FDI,
 * suspect isolation - for the full twin and two baselines (see sim.ts).
 * Writes docs/results/evaluation.json, evaluation.md and SVG charts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_TOPOLOGY, type SegmentId, type SensorId } from '@twin/contracts';
import { barChart } from './svg';
import { commission, pick, rnd, Run, seedRandom, type Detector } from './sim';

const { values: a } = parseArgs({ options: { quick: { type: 'boolean', default: false }, seed: { type: 'string', default: '7' } } });
const Q = a.quick;
const N = { leaks: Q ? 60 : 400, thefts: Q ? 20 : 100, normalRuns: Q ? 3 : 12, normalMin: Q ? 20 : 30, attackReps: Q ? 1 : 4 };
seedRandom(Number(a.seed));
const t0All = Date.now();
const OUT = resolve(import.meta.dirname, '../../../docs/results');
mkdirSync(OUT, { recursive: true });
const pos = DEFAULT_TOPOLOGY.positionsM;
const DETECTORS: Detector[] = ['B1', 'B2', 'TWIN'];

console.log('Commissioning: learning the twin model once (60 s healthy baseline)...');
const params = commission();

/** New run at a random operating point, warmed up 30 s, events cleared. */
function freshRun(): Run {
  const r = new Run(params, 1_800_000_000_000 + Math.floor(Math.random() * 1e9));
  r.rig.plant.outletOpening = rnd(0.6, 1);
  r.rig.plant.dutyCmd = pick([100, 100, 90, 80]);
  r.run(30);
  r.resetEvents();
  return r;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]! : NaN);
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;

// =============================================================== 1-2. leaks and thefts
interface LossResult { kind: 'leak' | 'theft'; segment: SegmentId; positionM: number; size: number; trueLoss: number;
  delay: Partial<Record<Detector, number>>; classified?: string; locSeg?: string; locPos?: number | null; integrityFalse: boolean }
const losses: LossResult[] = [];
const SIZES = [0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5, 0.8, 1.2];

function lossScenario(kind: 'leak' | 'theft', size: number) {
  const r = freshRun();
  const segment = pick(['A', 'B'] as const);
  const fraction = rnd(0.15, 0.85);
  const seg = DEFAULT_TOPOLOGY.segments[segment];
  const positionM = pos[seg.from] + fraction * (pos[seg.to] - pos[seg.from]);
  const t0 = r.rig.now;
  const id = r.rig.leak(segment, size, { fraction, rampS: kind === 'theft' ? rnd(6, 15) : 0, kind });
  r.run(60);
  const res: LossResult = {
    kind, segment, positionM, size, trueLoss: r.rig.plant.truth().tapFlows[id] ?? 0, delay: {},
    integrityFalse: !!r.first('TWIN', 'integrity'),
  };
  for (const d of DETECTORS) {
    const e = r.first(d, 'loss');
    if (e) res.delay[d] = (e.ts - t0) / 1000;
  }
  if (r.lastLoss) {
    res.classified = r.lastLoss.type;
    res.locSeg = r.lastLoss.segment;
    res.locPos = (r.lastLoss.data as { positionM?: number | null }).positionM ?? null;
  }
  losses.push(res);
}

console.log(`Campaign 1: ${N.leaks} leaks...`);
for (let i = 0; i < N.leaks; i++) lossScenario('leak', SIZES[i % SIZES.length]! * rnd(0.9, 1.1));
console.log(`Campaign 2: ${N.thefts} thefts...`);
for (let i = 0; i < N.thefts; i++) lossScenario('theft', rnd(0.4, 1.2));

// =============================================================== 3. normal operation
console.log(`Campaign 3: ${N.normalRuns} x ${N.normalMin} min of normal operation...`);
const fa: Record<Detector, number> = { B1: 0, B2: 0, TWIN: 0 };
let faIntegrity = 0;
let normalHours = 0;
let opChanges = 0;
for (let k = 0; k < N.normalRuns; k++) {
  const r = freshRun();
  let t = 0;
  const total = N.normalMin * 60;
  while (t < total) {
    const step = Math.min(rnd(90, 300), total - t);
    r.run(step);
    t += step;
    const ev = Math.random();
    opChanges++;
    if (ev < 0.6) r.rig.plant.outletOpening = rnd(0.45, 1);
    else if (ev < 0.85) r.rig.plant.dutyCmd = pick([70, 80, 90, 100]);
    else {
      r.rig.plant.pumpOn = false;
      r.run(20);
      t += 20;
      r.rig.plant.pumpOn = true;
    }
  }
  for (const d of DETECTORS) fa[d] += r.events.filter((e) => e.detector === d && e.kind === 'loss').length;
  faIntegrity += r.events.filter((e) => e.detector === 'TWIN' && e.kind === 'integrity').length;
  normalHours += total / 3600;
}

// =============================================================== 4. attacks and faults
console.log('Campaign 4: false data injection and sensor faults...');
interface AttackResult { name: string; sensor?: string; realLeak: boolean; detected: boolean; delay?: number; falseLoss: Record<Detector, boolean>; falseShutdown: Record<Detector, boolean>; suspects?: string[]; isolated?: boolean }
const attacks: AttackResult[] = [];
function attackScenario(name: string, sensor: SensorId | undefined, inject: (r: Run) => void, reveal?: (r: Run) => void, realLeak = false) {
  const r = freshRun();
  const t0 = r.rig.now;
  inject(r);
  r.run(20);
  if (reveal) reveal(r); // operating change that reveals stuck / frozen values
  r.run(40);
  const det = r.first('TWIN', 'integrity');
  const suspects = det?.suspects ?? (r.lastIntegrity?.data as { suspects?: string[] } | undefined)?.suspects;
  attacks.push({
    name, sensor, realLeak, detected: !!det, delay: det ? (det.ts - t0) / 1000 : undefined, suspects,
    isolated: sensor && suspects ? suspects.includes(sensor) : undefined,
    falseLoss: { B1: !!r.first('B1', 'loss'), B2: !!r.first('B2', 'loss'), TWIN: !!r.first('TWIN', 'loss') },
    falseShutdown: { B1: !!r.first('B1', 'shutdown'), B2: !!r.first('B2', 'shutdown'), TWIN: !!r.first('TWIN', 'shutdown') },
  });
}
const valve = (r: Run) => (r.rig.plant.outletOpening = r.rig.plant.outletOpening > 0.75 ? 0.5 : 1);
for (let rep = 0; rep < N.attackReps; rep++) {
  for (const s of ['P1', 'P2', 'P3'] as SensorId[]) {
    for (const d of [0.3, 0.8, -0.5]) attackScenario(`bias ${s} ${d > 0 ? '+' : ''}${d} bar`, s, (r) => r.rig.attack({ type: 'fdi_bias', sensor: s, delta: d }));
    attackScenario(`freeze ${s} + valve change`, s, (r) => r.rig.attack({ type: 'fdi_freeze', sensor: s }), valve);
    attackScenario(`stuck ${s} (fault) + valve change`, s, (r) => r.rig.fault(s, 'stuck'), valve);
    attackScenario(`drift ${s} 0.5 bar/min (fault)`, s, (r) => r.rig.fault(s, 'drift', 0.5));
  }
  for (const s of ['F1', 'F2'] as SensorId[]) {
    for (const d of [0.3, 0.6, -0.4]) attackScenario(`bias ${s} ${d > 0 ? '+' : ''}${d} L/min`, s, (r) => r.rig.attack({ type: 'fdi_bias', sensor: s, delta: d }));
    attackScenario(`ramp ${s} +0.01 L/min/s`, s, (r) => r.rig.attack({ type: 'fdi_ramp', sensor: s, ratePerS: 0.01 }));
  }
  attackScenario('replay downstream + real leak (hide it)', 'P2', (r) => r.rig.attack({ type: 'fdi_replay', device: 'node-downstream', recordS: 15 }), (r) => r.rig.leak('B', 0.6), true);
}

// =============================================================== metrics
const leaks = losses.filter((l) => l.kind === 'leak');
const thefts = losses.filter((l) => l.kind === 'theft');
const bins: Array<[number, number, string]> = [[0, 0.09, '< 0.09'], [0.09, 0.14, '0.09-0.14'], [0.14, 0.25, '0.14-0.25'], [0.25, 0.6, '0.25-0.6'], [0.6, 9, '> 0.6']];
const byBin = bins.map(([lo, hi, label]) => {
  const xs = leaks.filter((l) => l.trueLoss >= lo && l.trueLoss < hi);
  const row: Record<string, unknown> = { bin: `${label} L/min`, n: xs.length, percentOfFlow: xs.length ? r2((100 * median(xs.map((x) => x.trueLoss))) / params!.nominal.F1) : null };
  for (const d of DETECTORS) {
    const det = xs.filter((x) => x.delay[d] !== undefined);
    row[`${d}_rate`] = xs.length ? r2(det.length / xs.length) : null;
    row[`${d}_delay_med`] = det.length ? r2(median(det.map((x) => x.delay[d]!))) : null;
    row[`${d}_delay_p95`] = det.length ? r2(pct(det.map((x) => x.delay[d]!), 0.95)) : null;
  }
  return row;
});
const located = losses.filter((l) => l.locPos != null);
const locErr = located.map((l) => Math.abs((l.locPos as number) - l.positionM));
const segOk = located.filter((l) => l.locSeg === l.segment).length;
const detectedLosses = losses.filter((l) => l.classified);
const conf = {
  leak_as_leak: detectedLosses.filter((l) => l.kind === 'leak' && l.classified === 'leak').length,
  leak_as_theft: detectedLosses.filter((l) => l.kind === 'leak' && l.classified === 'theft').length,
  theft_as_theft: detectedLosses.filter((l) => l.kind === 'theft' && l.classified === 'theft').length,
  theft_as_leak: detectedLosses.filter((l) => l.kind === 'theft' && l.classified === 'leak').length,
};
const fdi = attacks;
const noLeak = attacks.filter((x) => !x.realLeak); // false-alarm statistics only where no real leak exists
const summary = {
  seed: Number(a.seed),
  quick: Q,
  model: { RA: params!.RA, RB: params!.RB, c: params!.c, sigmaMass: params!.sigma.mass, nominalFlow: params!.nominal.F1 },
  leaks: {
    n: leaks.length,
    detectionRate: Object.fromEntries(DETECTORS.map((d) => [d, r2(leaks.filter((l) => l.delay[d] !== undefined).length / leaks.length)])) as Record<Detector, number>,
    byBin,
    misdiagnosedAsFdi: losses.filter((l) => l.integrityFalse).length,
  },
  thefts: { n: thefts.length, detectionRate: r2(thefts.filter((l) => l.delay.TWIN !== undefined).length / Math.max(thefts.length, 1)), delayMedian: r2(median(thefts.filter((l) => l.delay.TWIN).map((l) => l.delay.TWIN!))) },
  localisation: { n: located.length, segmentAccuracy: r2(segOk / Math.max(located.length, 1)), meanErrorM: r2(locErr.reduce((x, y) => x + y, 0) / Math.max(locErr.length, 1)), p95ErrorM: r2(pct(locErr, 0.95)), pipeLengthM: pos.P3 - pos.P1 },
  classification: { ...conf, accuracy: r2((conf.leak_as_leak + conf.theft_as_theft) / Math.max(detectedLosses.length, 1)) },
  falseAlarms: { hours: r2(normalHours), operatingChanges: opChanges, perHour: Object.fromEntries(DETECTORS.map((d) => [d, r2(fa[d] / normalHours)])) as Record<Detector, number>, integrityPerHour: r2(faIntegrity / normalHours) },
  attacks: {
    n: fdi.length,
    detectionRate: r2(fdi.filter((x) => x.detected).length / fdi.length),
    delayMedian: r2(median(fdi.filter((x) => x.detected).map((x) => x.delay!))),
    isolationRate: r2(fdi.filter((x) => x.isolated).length / Math.max(fdi.filter((x) => x.detected).length, 1)),
    falseLossRate: Object.fromEntries(DETECTORS.map((d) => [d, r2(noLeak.filter((x) => x.falseLoss[d]).length / noLeak.length)])) as Record<Detector, number>,
    falseShutdownRate: Object.fromEntries(DETECTORS.map((d) => [d, r2(noLeak.filter((x) => x.falseShutdown[d]).length / noLeak.length)])) as Record<Detector, number>,
    byType: Object.values(fdi.reduce<Record<string, { name: string; n: number; detected: number; isolated: number; falseLossTwin: number; falseShutdownTwin: number; falseLossB1: number; delays: number[] }>>((acc, x) => {
      const k = x.name;
      acc[k] ??= { name: k, n: 0, detected: 0, isolated: 0, falseLossTwin: 0, falseShutdownTwin: 0, falseLossB1: 0, delays: [] };
      acc[k].n++;
      if (x.detected) { acc[k].detected++; acc[k].delays.push(x.delay!); }
      if (x.isolated) acc[k].isolated++;
      if (x.falseLoss.TWIN && !x.realLeak) acc[k].falseLossTwin++;
      if (x.falseShutdown.TWIN && !x.realLeak) acc[k].falseShutdownTwin++;
      if (x.falseLoss.B1 && !x.realLeak) acc[k].falseLossB1++;
      return acc;
    }, {})).map(({ delays, ...rest }) => ({ ...rest, delayMedian: delays.length ? r2(median(delays)) : null })),
  },
  runtimeS: Math.round((Date.now() - t0All) / 1000),
};

// =============================================================== outputs
writeFileSync(resolve(OUT, 'evaluation.json'), JSON.stringify({ summary, losses, attacks }, null, 2) + '\n');
writeFileSync(resolve(OUT, 'detection-rate.svg'), barChart('Leak detection rate by leak size', byBin.map((b) => b.bin as string),
  DETECTORS.map((d) => ({ name: d === 'B1' ? 'B1 naive mass balance' : d === 'B2' ? 'B2 threshold only' : 'Digital twin', values: byBin.map((b) => (b[`${d}_rate`] as number | null) ?? 0) })), { max: 1, unit: '' }));
writeFileSync(resolve(OUT, 'detection-delay.svg'), barChart('Median detection delay (s) by leak size', byBin.map((b) => b.bin as string),
  DETECTORS.map((d) => ({ name: d === 'B1' ? 'B1 naive mass balance' : d === 'B2' ? 'B2 threshold only' : 'Digital twin', values: byBin.map((b) => (b[`${d}_delay_med`] as number | null) ?? 0) })), { unit: ' s' }));

const s = summary;
const fmt = (x: unknown) => (x === null || x === undefined || Number.isNaN(x) ? '-' : String(x));
let md = `# Evaluation results (Phase 9)

Generated by \`npm run offline -w @twin/evaluation\` (seed ${s.seed}${s.quick ? ', quick mode' : ''}, ${s.runtimeS} s).
Emulator physics in virtual time, fed through the **real** twin code (TwinCore +
plausibility checks). Model learned once (commissioning): RA=${s.model.RA.toFixed(4)},
RB=${s.model.RB.toFixed(4)}, c=${s.model.c.toFixed(3)}, sigma(mass)=${s.model.sigmaMass.toFixed(3)} L/min,
nominal flow ${s.model.nominalFlow.toFixed(2)} L/min.

Detectors: **B1** naive mass balance on reported flows (F1-F2 > 0.3 L/min, 3 samples) -
**B2** twin residual with threshold only (5 sigma, 3 s) - **TWIN** full digital twin
(threshold + CUSUM + consistency diagnosis + plausibility).

## 1. Leak detection (${s.leaks.n} leaks, random position, size and operating point)

| Leak size | n | % of flow | B1 rate | B2 rate | TWIN rate | B1 delay (med) | B2 delay (med) | TWIN delay (med / p95) |
|-----------|---|-----------|---------|---------|-----------|----------------|----------------|------------------------|
${s.leaks.byBin.map((b) => `| ${b.bin} | ${b.n} | ${fmt(b.percentOfFlow)} | ${fmt(b.B1_rate)} | ${fmt(b.B2_rate)} | ${fmt(b.TWIN_rate)} | ${fmt(b.B1_delay_med)} s | ${fmt(b.B2_delay_med)} s | ${fmt(b.TWIN_delay_med)} / ${fmt(b.TWIN_delay_p95)} s |`).join('\n')}
| **all** | ${s.leaks.n} | | ${s.leaks.detectionRate.B1} | ${s.leaks.detectionRate.B2} | **${s.leaks.detectionRate.TWIN}** | | | |

Real leaks wrongly diagnosed as data manipulation: ${s.leaks.misdiagnosedAsFdi} / ${losses.length}.

![detection rate](detection-rate.svg)
![detection delay](detection-delay.svg)

## 2. Theft (${s.thefts.n} hand-opened taps, 6-15 s valve opening)

Detection rate ${s.thefts.detectionRate}, median delay ${s.thefts.delayMedian} s.

## 3. Localisation (${s.localisation.n} located losses, pipe ${s.localisation.pipeLengthM} m between P1 and P3)

| Segment correct | Mean position error | 95th percentile |
|-----------------|---------------------|-----------------|
| ${(s.localisation.segmentAccuracy * 100).toFixed(0)} % | ${s.localisation.meanErrorM} m | ${s.localisation.p95ErrorM} m |

## 4. Leak vs theft classification

| | classified leak | classified theft |
|---|---|---|
| true leak | ${s.classification.leak_as_leak} | ${s.classification.leak_as_theft} |
| true theft | ${s.classification.theft_as_leak} | ${s.classification.theft_as_theft} |

Accuracy: ${(s.classification.accuracy * 100).toFixed(1)} %.

## 5. False alarms (${s.falseAlarms.hours} h of normal operation, ${s.falseAlarms.operatingChanges} operating changes: valve, pump speed, stops)

| Detector | False leak alarms per hour |
|----------|----------------------------|
| B1 naive mass balance | ${s.falseAlarms.perHour.B1} |
| B2 threshold only | ${s.falseAlarms.perHour.B2} |
| **TWIN** | **${s.falseAlarms.perHour.TWIN}** |

False data-integrity alarms (TWIN): ${s.falseAlarms.integrityPerHour} per hour.

## 6. False data injection and sensor faults (${s.attacks.n} scenarios)

Detected: ${(s.attacks.detectionRate * 100).toFixed(0)} % (median ${s.attacks.delayMedian} s); attacked sensor among the suspects: ${(s.attacks.isolationRate * 100).toFixed(0)} % of detections.

Scenarios without a real leak (${noLeak.length}):

| Consequence of the attack | B1 naive | B2 threshold | **TWIN** |
|---------------------------|----------|--------------|----------|
| false leak alarm | ${(s.attacks.falseLossRate.B1 * 100).toFixed(0)} % | ${(s.attacks.falseLossRate.B2 * 100).toFixed(0)} % | **${(s.attacks.falseLossRate.TWIN * 100).toFixed(0)} %** |
| false **automatic shutdown** (denial of service) | ${(s.attacks.falseShutdownRate.B1 * 100).toFixed(0)} % | ${(s.attacks.falseShutdownRate.B2 * 100).toFixed(0)} % | **${(s.attacks.falseShutdownRate.TWIN * 100).toFixed(0)} %** |

(B1/B2 have no integrity check, so any alarm would act on the pump. The twin's
supervisor only stops the pump on a confirmed, physically consistent loss.)

| Scenario | n | detected | delay (med) | suspect correct | false leak TWIN | false shutdown TWIN | false leak B1 |
|----------|---|----------|-------------|-----------------|-----------------|---------------------|---------------|
${s.attacks.byType.map((x) => `| ${x.name} | ${x.n} | ${x.detected} | ${fmt(x.delayMedian)} s | ${x.isolated} | ${x.falseLossTwin} | ${x.falseShutdownTwin} | ${x.falseLossB1} |`).join('\n')}

## 7. Security tests (attack scripts, live stack)

See [security-tests.json](security-tests.json) - produced by \`npm run all -w @twin/attacks\`.
`;
writeFileSync(resolve(OUT, 'evaluation.md'), md);
console.log(`\nDone in ${s.runtimeS} s. Leak detection TWIN ${s.leaks.detectionRate.TWIN} (B1 ${s.leaks.detectionRate.B1}, B2 ${s.leaks.detectionRate.B2}); ` +
  `false alarms/h TWIN ${s.falseAlarms.perHour.TWIN} (B1 ${s.falseAlarms.perHour.B1}, B2 ${s.falseAlarms.perHour.B2}); ` +
  `localisation segment ${s.localisation.segmentAccuracy}, error ${s.localisation.meanErrorM} m; classification ${s.classification.accuracy}; ` +
  `FDI detected ${s.attacks.detectionRate}, false shutdown TWIN ${s.attacks.falseShutdownRate.TWIN} vs B1 ${s.attacks.falseShutdownRate.B1}`);
console.log('written docs/results/evaluation.md, evaluation.json, detection-rate.svg, detection-delay.svg');
