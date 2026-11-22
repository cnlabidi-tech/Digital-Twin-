/**
 * Calibration helper. Measures through MQTT (read-only), computes the
 * constants, and prints the exact serial-console lines to type on the board
 * (calibration is deliberately NOT possible over the network).
 *
 *   npm run cal -w @twin/calibration -- <command> [options]
 *
 * divider --vin 4.998 --vout 3.326
 *     Resistor-divider ratio, from two multimeter readings (same for all channels
 *     of a board if the resistors are matched; else use the worst one).
 *
 * zero --device node-inlet [--seconds 20] [--divider 0.6667]
 *     Pump OFF, pipe open to atmosphere (0 bar gauge). Computes each pressure
 *     sensor's offset so that it reads 0.000 bar.
 *
 * span --sensor P1 --reference 3.50 [--offset 0.012] [--seconds 20] [--divider 0.6667]
 *     Pump ON, a reference gauge at the same point reads --reference bar.
 *     Computes the gain (keep the offset found by "zero").
 *
 * flow --device node-inlet --volume 2.0            (bucket test, interactive)
 * flow --device node-inlet --reference-lpm 3.45 [--seconds 30]   (reference meter)
 *     K-factor of the YF-S201 = pulses per second per L/min = pulses per litre / 60.
 *
 * emulator-params
 *     Converts the twin model learned on the REAL rig into emulator parameters
 *     (EMU_HYDRAULICS), so that simulations reproduce the real pipe.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_TOPOLOGY, DEVICE_SENSORS, type DeviceId, type SensorId } from '@twin/contracts';
import { API, capture, connectMonitor, countsToBarRaw, login, mean, std } from './common';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    device: { type: 'string' },
    sensor: { type: 'string' },
    seconds: { type: 'string', default: '20' },
    divider: { type: 'string', default: String(2 / 3) },
    reference: { type: 'string' },
    offset: { type: 'string', default: '0' },
    vin: { type: 'string' },
    vout: { type: 'string' },
    volume: { type: 'string' },
    'reference-lpm': { type: 'string' },
  },
});
const cmd = positionals[0];
const divider = Number(a.divider);
const seconds = Number(a.seconds);
const printCal = (lines: string[]) => {
  console.log('\nType these lines in the board\'s serial console (pio device monitor):\n');
  for (const l of [...lines, 'cal save', 'cal show']) console.log(`    ${l}`);
  console.log('');
};

async function rawSamples(device: DeviceId, s: number) {
  const c = await connectMonitor();
  console.log(`Measuring ${device} for ${s} s ...`);
  const { telemetry } = await capture(c, s, (n) => process.stdout.write(`\r  ${n} messages`));
  c.end(true);
  console.log('');
  const msgs = telemetry.filter((m) => m.t.deviceId === device).map((m) => m.t);
  if (msgs.length < 5) throw new Error(`only ${msgs.length} messages from ${device} - is it online?`);
  return msgs;
}

switch (cmd) {
  case 'divider': {
    const vin = Number(a.vin);
    const vout = Number(a.vout);
    if (!(vin > 0 && vout > 0 && vout < vin)) throw new Error('give --vin and --vout (volts, vout < vin)');
    const ratio = vout / vin;
    console.log(`divider ratio = ${vout} / ${vin} = ${ratio.toFixed(5)} (nominal 0.66667, deviation ${((ratio / (2 / 3) - 1) * 100).toFixed(2)} %)`);
    printCal([`cal set divider ${ratio.toFixed(5)}`]);
    break;
  }

  case 'zero': {
    const device = a.device as DeviceId;
    if (!DEVICE_SENSORS[device]) throw new Error('--device node-inlet | node-downstream');
    const msgs = await rawSamples(device, seconds);
    if (msgs.some((m) => m.actuators?.pump.on)) console.log('  WARNING: the pump is ON - zero calibration must be done at 0 bar (pump off, pipe vented).');
    const lines: string[] = [];
    for (const s of DEVICE_SENSORS[device].filter((x) => x.startsWith('P'))) {
      const counts = msgs.map((m) => m.sensors[s]!.raw);
      const bar = countsToBarRaw(mean(counts), divider);
      const noise = std(counts.map((c) => countsToBarRaw(c, divider)));
      console.log(`  ${s}: mean ${mean(counts).toFixed(1)} counts = ${bar.toFixed(4)} bar uncalibrated (noise ${noise.toFixed(4)} bar)`);
      if (Math.abs(bar) > 0.5) console.log(`  WARNING: ${s} far from 0 bar - check the divider value and that the pipe is vented.`);
      lines.push(`cal set ${s}.offset ${(-bar).toFixed(4)}`);
    }
    printCal(lines);
    break;
  }

  case 'span': {
    const sensor = a.sensor as SensorId;
    const ref = Number(a.reference);
    const offset = Number(a.offset);
    const device = (Object.entries(DEVICE_SENSORS) as [DeviceId, SensorId[]][]).find(([, ss]) => ss.includes(sensor))?.[0];
    if (!device || !sensor.startsWith('P') || !Number.isFinite(ref)) throw new Error('--sensor P1|P2|P3 --reference <bar> [--offset <from zero>]');
    const msgs = await rawSamples(device, seconds);
    const bar = countsToBarRaw(mean(msgs.map((m) => m.sensors[sensor]!.raw)), divider);
    if (bar < 1) console.log('  WARNING: pressure below 1 bar - span calibration is more accurate at a high pressure.');
    const gain = (ref - offset) / bar;
    console.log(`  ${sensor}: uncalibrated ${bar.toFixed(4)} bar, reference ${ref} bar, offset ${offset} -> gain ${gain.toFixed(5)}`);
    if (Math.abs(gain - 1) > 0.1) console.log('  WARNING: gain differs by more than 10 % - check the reference gauge and the divider.');
    printCal([`cal set ${sensor}.gain ${gain.toFixed(5)}`]);
    break;
  }

  case 'flow': {
    const device = a.device as DeviceId;
    if (!DEVICE_SENSORS[device]) throw new Error('--device node-inlet | node-downstream');
    const sensor = DEVICE_SENSORS[device].find((s) => s.startsWith('F'))!;
    let pulses: number;
    let durS: number;
    let refLpm: number;
    if (a.volume) {
      // Interactive bucket test: pulses counted between two Enter presses.
      const volume = Number(a.volume);
      const c = await connectMonitor();
      let lastRaw = 0;
      let lastTs = 0;
      c.on('message', (_t, p) => {
        try {
          const j = JSON.parse(p.toString());
          if (j.deviceId === device && j.sensors?.[sensor]) {
            lastRaw = j.sensors[sensor].raw;
            lastTs = j.ts;
          }
        } catch { /* ignore */ }
      });
      await c.subscribeAsync(`pipeline/v1/${device}/telemetry`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(`Put the outlet hose over an EMPTY measuring container, start the pump, then press Enter to START counting...`);
      const startRaw = lastRaw;
      const startTs = lastTs;
      await rl.question(`Fill exactly ${volume} L, then press Enter to STOP...`);
      rl.close();
      c.end(true);
      pulses = lastRaw - startRaw;
      durS = (lastTs - startTs) / 1000;
      refLpm = volume / (durS / 60);
      console.log(`  ${pulses} pulses for ${volume} L in ${durS.toFixed(1)} s (${refLpm.toFixed(3)} L/min) = ${(pulses / volume).toFixed(1)} pulses/L`);
    } else if (a['reference-lpm']) {
      refLpm = Number(a['reference-lpm']);
      const msgs = await rawSamples(device, seconds);
      pulses = msgs[msgs.length - 1]!.sensors[sensor]!.raw - msgs[0]!.sensors[sensor]!.raw;
      durS = (msgs[msgs.length - 1]!.ts - msgs[0]!.ts) / 1000;
      console.log(`  ${pulses} pulses in ${durS.toFixed(1)} s at reference ${refLpm} L/min`);
    } else {
      throw new Error('give --volume <litres> (bucket test) or --reference-lpm <L/min>');
    }
    const k = pulses / durS / refLpm;
    console.log(`  K = ${k.toFixed(4)} pulses/s per L/min (YF-S201 nominal 7.5; ${((k / 7.5 - 1) * 100).toFixed(1)} %)`);
    if (durS < 30) console.log('  note: measure at least 30 s for +/-1 % (1 pulse = ~0.13 % of 2 L).');
    printCal([`cal set ${sensor}.k ${k.toFixed(4)}`]);
    break;
  }

  case 'emulator-params': {
    const token = await login();
    if (!token) throw new Error('cannot log in to the platform (TWIN_USER / TWIN_PASSWORD)');
    const r = (await (await fetch(`${API}/api/twin`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      params: { pumpA: number; pumpB: number; RA: number; RB: number; Rout: number } | null;
    };
    if (!r.params) throw new Error('the twin has no learned model yet');
    const p = r.params;
    const pos = DEFAULT_TOPOLOGY.positionsM;
    const LA = pos.P2 - pos.P1;
    const LB = pos.P3 - pos.P2;
    const hyd = {
      pumpShutoffBar: +p.pumpA.toFixed(3),
      pumpMaxFlowLpm: +Math.sqrt(p.pumpA / p.pumpB).toFixed(3),
      pipeK: +((p.RA / LA + p.RB / LB) / 2).toFixed(5),
      outletK: +p.Rout.toFixed(5),
    };
    console.log('Hydraulic parameters identified on the real rig:');
    console.log(JSON.stringify(hyd, null, 2));
    console.log(`\nRun the emulator with them:\n    EMU_HYDRAULICS='${JSON.stringify(hyd)}' npm run emu`);
    break;
  }

  default:
    console.log('commands: divider | zero | span | flow | emulator-params   (see the header of tools/calibration/src/calibrate.ts)');
}
process.exit(0);
