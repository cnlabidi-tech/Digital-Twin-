/**
 * Steady-state hydraulic model of the prototype (used ONLY by the emulator to
 * produce realistic "physical" values; the twin has its own model in Phase 4).
 *
 *   reservoir -> pump -> [P1]-[F1]--- segment A ---[P2]--- segment B ---[P3]-[F2] -> outlet valve -> reservoir
 *                               ^ taps (leaks / theft) can be anywhere along the pipe
 *
 * Units: pressure in bar (gauge), flow in L/min, position in metres.
 *
 * Laws used (simple, standard, explainable):
 *  - Pump curve (quadratic) with affinity law for PWM duty d in [0,1]:
 *        P_pump(Q) = Pshut * d^2 * (1 - (Q / (Qmax * d))^2)
 *  - Friction loss along the pipe (Darcy-Weisbach, turbulent => ~Q^2):
 *        dP = kPipe * L * Q^2
 *  - Outlet valve (orifice):  P_end = kOut / opening^2 * Q^2
 *  - Tap (leak or theft) to atmosphere (orifice / Torricelli):
 *        Q_tap = C * open * sqrt(P_local)
 *
 * Solution: the only unknown is the pump flow Q1. For a guess of Q1 we march
 * from the pump to the outlet, subtracting friction and tap flows; the outlet
 * pressure left over must equal what the outlet valve needs. That residual is
 * monotonic in Q1, so a bisection finds the operating point.
 */

export interface HydraulicParams {
  pumpShutoffBar: number; // pressure at zero flow, duty 100 %
  pumpMaxFlowLpm: number; // flow at zero pressure, duty 100 %
  pipeK: number; // friction coefficient, bar / (m * (L/min)^2)
  outletK: number; // outlet valve coefficient when fully open, bar / (L/min)^2
  pipeEndM: number; // position of the outlet valve
}

export const DEFAULT_HYDRAULICS: HydraulicParams = {
  // Datasheet: 0.8 MPa = 8 bar shut-off, 5 L/min free flow.
  pumpShutoffBar: 8,
  pumpMaxFlowLpm: 5,
  // Tuned so that the nominal point is ~3.5 L/min, P1 ~4.1, P2 ~3.6, P3 ~3.1 bar.
  // Replaced by values fitted on the real rig in Phase 8.
  pipeK: 0.02,
  outletK: 0.25,
  pipeEndM: 4.3,
};

export interface Tap {
  id: string;
  kind: 'leak' | 'theft';
  positionM: number;
  /** Orifice coefficient, L/min per sqrt(bar). */
  coeff: number;
  /** Current opening 0..1 (ramps when a valve is turned slowly). */
  opening: number;
}

export interface OperatingPoint {
  /** Pump (inlet) flow. */
  q1: number;
  /** Flow leaving through the outlet valve. */
  qOut: number;
  /** Pressure at any position (piecewise, evaluated at the requested points). */
  pressureAt: Record<string, number>;
  /** Flow in the pipe at the requested points. */
  flowAt: Record<string, number>;
  /** Flow lost through each tap. */
  tapFlows: Record<string, number>;
}

/** Conversion helper: coefficient that gives `rateLpm` at `refBar` gauge pressure. */
export const coeffFromRate = (rateLpm: number, refBar = 3): number => rateLpm / Math.sqrt(refBar);

function pumpPressure(q: number, duty: number, p: HydraulicParams): number {
  if (duty <= 0) return 0;
  const qmax = p.pumpMaxFlowLpm * duty;
  return Math.max(0, p.pumpShutoffBar * duty * duty * (1 - (q / qmax) ** 2));
}

/**
 * March along the pipe for a given pump flow. Returns the outlet residual and
 * the profile at the probe points.
 */
function march(
  q1: number,
  duty: number,
  outletOpening: number,
  taps: Tap[],
  probes: Record<string, number>,
  p: HydraulicParams,
) {
  type Ev = { pos: number; tap?: Tap; probe?: string };
  const events: Ev[] = ([
    ...taps.filter((t) => t.opening > 0).map((t) => ({ pos: t.positionM, tap: t })),
    ...Object.entries(probes).map(([name, pos]) => ({ pos, probe: name })),
  ] as Ev[])
    .sort((a, b) => a.pos - b.pos || (a.probe ? -1 : 1)); // probe before a tap at the same spot

  let pos = 0;
  let pr = pumpPressure(q1, duty, p);
  let q = q1;
  const pressureAt: Record<string, number> = {};
  const flowAt: Record<string, number> = {};
  const tapFlows: Record<string, number> = {};

  for (const ev of events) {
    pr -= p.pipeK * (ev.pos - pos) * q * Math.abs(q);
    pos = ev.pos;
    if (ev.probe) {
      pressureAt[ev.probe] = pr;
      flowAt[ev.probe] = q;
    } else if (ev.tap) {
      const qt = ev.tap.coeff * ev.tap.opening * Math.sqrt(Math.max(pr, 0));
      tapFlows[ev.tap.id] = qt;
      q -= qt;
    }
  }
  pr -= p.pipeK * (p.pipeEndM - pos) * q * Math.abs(q);
  const kOut = p.outletK / Math.max(outletOpening, 0.02) ** 2;
  const needed = kOut * q * Math.abs(q);
  return { residual: pr - needed, qOut: q, pressureAt, flowAt, tapFlows };
}

/** Solve the operating point of the network. */
export function solve(
  duty: number,
  outletOpening: number,
  taps: Tap[],
  probes: Record<string, number>,
  p: HydraulicParams = DEFAULT_HYDRAULICS,
): OperatingPoint {
  if (duty <= 0) {
    const zeros = Object.fromEntries(Object.keys(probes).map((k) => [k, 0]));
    return { q1: 0, qOut: 0, pressureAt: { ...zeros }, flowAt: { ...zeros }, tapFlows: {} };
  }
  // residual(Q1) is decreasing: high at Q1=0 (pump pushes, nothing flows), negative at Qmax.
  let lo = 0;
  let hi = p.pumpMaxFlowLpm * duty;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (march(mid, duty, outletOpening, taps, probes, p).residual > 0) lo = mid;
    else hi = mid;
  }
  const q1 = (lo + hi) / 2;
  const r = march(q1, duty, outletOpening, taps, probes, p);
  return { q1, qOut: r.qOut, pressureAt: r.pressureAt, flowAt: r.flowAt, tapFlows: r.tapFlows };
}
