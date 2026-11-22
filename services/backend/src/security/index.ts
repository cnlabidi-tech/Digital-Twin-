/**
 * Security module wiring (Phase 6).
 *  - loads the per-device HMAC keys
 *  - installs the message security gate in the ingestion pipeline
 *  - signs outgoing commands with the target device's key
 *  - runs the temporal plausibility checks (FDI) and raises alerts
 */
import { existsSync, readFileSync } from 'node:fs';
import type { DeviceId } from '@twin/contracts';
import { signMessage } from '@twin/contracts/signing';
import type { AlertService } from '../alerts/service';
import { bus } from '../bus';
import { config } from '../config';
import type { CommandService } from '../control/commands';
import { setSecurityGate } from '../ingestion/handler';
import { createSecurityGate } from './gate';
import { PlausibilityChecker } from './plausibility';

const FINDING_CLEAR_MS = 15_000;
const CHECK_TEXT = {
  frozen: 'value frozen while the pump runs (stuck sensor or forged data)',
  replayed: 'values repeat an earlier recorded sequence (replayed data)',
  jump: 'physically impossible jump between two samples',
  raw_mismatch: 'reported value does not match its own raw measurement (forged value)',
} as const;

export function setupSecurity(deps: { alerts: AlertService; commands: CommandService; log: { info: (m: string) => void; warn: (m: string) => void } }) {
  const f = config.security.deviceKeysFile;
  const keys: Partial<Record<DeviceId, string>> = f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  deps.log.info(`security mode: ${config.securityMode}; device keys: ${Object.keys(keys).join(', ') || 'none'}; signatures ${config.security.requireSignatures ? 'REQUIRED' : 'optional'}`);

  const { gate, stats } = createSecurityGate({
    keys,
    requireSignatures: config.security.requireSignatures,
    maxClockSkewMs: config.security.maxClockSkewMs,
    maxRatePerDevice: config.security.maxRatePerDevice,
  });
  setSecurityGate(gate);

  // Commands are signed with the key of the device they are addressed to.
  deps.commands.signer = (deviceId, msg) => {
    const k = keys[deviceId];
    return k ? signMessage(msg, k) : JSON.stringify(msg);
  };

  // Temporal plausibility (FDI by a compromised but correctly-signing device)
  const checker = new PlausibilityChecker();
  const lastSeen = new Map<string, number>();
  bus.on('telemetry', ({ msg }) => {
    const now = Date.now();
    for (const finding of checker.check(msg)) {
      const key = `fdi:${finding.sensorId}:${finding.check}`;
      lastSeen.set(key, now);
      void deps.alerts.raise(key, {
        type: 'fdi', severity: 'critical', deviceId: msg.deviceId, sensorId: finding.sensorId,
        // Stable text (no live numbers) so the alert is not rewritten at every sample.
        message: `Implausible ${finding.sensorId} data: ${CHECK_TEXT[finding.check]}`,
        data: { check: finding.check, detail: finding.message },
      });
    }
    for (const [key, t] of lastSeen) {
      if (now - t > FINDING_CLEAR_MS) {
        lastSeen.delete(key);
        void deps.alerts.resolve(key, 'data plausible again');
      }
    }
  });

  return { stats, keys };
}
