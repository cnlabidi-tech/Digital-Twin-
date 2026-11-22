/**
 * Device & data-quality monitor (Phase 3). Raises the "infrastructure" alerts
 * that do not need the physical model:
 *   - device offline (last will / status) or silent (no telemetry > timeout)
 *   - device reboot (boot id changed)
 *   - sensor quality not "ok" (broken wire, ADC fault)
 *   - rejected messages (malformed / forged traffic) -> security alert
 * Physical anomalies (leak, theft, FDI) are raised by the twin (Phase 4).
 */
import { DEVICE_IDS, type DeviceId } from '@twin/contracts';
import { bus } from '../bus';
import type { AlertService } from './service';

const SILENCE_TIMEOUT_MS = 5000;
const SECURITY_QUIET_MS = 30_000;

export class DeviceMonitor {
  private lastTelemetry = new Map<DeviceId, number>();
  private bootIds = new Map<DeviceId, string>();
  private lastRejection = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly alerts: AlertService) {}

  start(): void {
    bus.on('status', ({ msg }) => {
      const key = `device_offline:${msg.deviceId}`;
      if (msg.online) {
        void this.alerts.resolve(key, 'device back online');
        void this.alerts.event('device', 'info', `${msg.deviceId} online (boot ${msg.bootId ?? '?'}, fw ${msg.fw ?? '?'})`, msg.deviceId);
      } else {
        const why = msg.reason === 'lwt' ? 'connection lost (last will)' : 'clean shutdown';
        void this.alerts.raise(key, { type: 'device_offline', severity: 'critical', deviceId: msg.deviceId, message: `${msg.deviceId} offline: ${why}` });
      }
    });

    bus.on('telemetry', ({ msg }) => {
      this.lastTelemetry.set(msg.deviceId, Date.now());
      void this.alerts.resolve(`device_silent:${msg.deviceId}`, 'telemetry resumed');
      const prevBoot = this.bootIds.get(msg.deviceId);
      if (prevBoot && prevBoot !== msg.bootId) {
        void this.alerts.event('device', 'warning', `${msg.deviceId} rebooted (boot ${prevBoot} -> ${msg.bootId})`, msg.deviceId);
      }
      this.bootIds.set(msg.deviceId, msg.bootId);
      for (const [sensorId, r] of Object.entries(msg.sensors)) {
        const key = `sensor_fault:${sensorId}`;
        if (r.q !== 'ok') {
          void this.alerts.raise(key, {
            type: 'sensor_fault', severity: 'warning', deviceId: msg.deviceId, sensorId,
            message: `${sensorId} quality ${r.q} - check wiring / sensor`,
            data: { quality: r.q, raw: r.raw },
          });
        } else if (this.alerts.isOpen(key)) {
          void this.alerts.resolve(key, 'quality ok');
        }
      }
    });

    bus.on('rejected', (r) => {
      const key = `security:${r.reason}:${r.deviceId ?? 'unknown'}`;
      const now = Date.now();
      const last = this.lastRejection.get(key) ?? 0;
      this.lastRejection.set(key, now);
      if (now - last > 5000) {
        // rate-limited history entry (an attack can produce thousands of messages)
        void this.alerts.event('security', 'warning', `Rejected message on ${r.topic}: ${r.reason}`, r.deviceId, r.details);
      }
      void this.alerts.raise(key, {
        type: 'security', severity: 'warning', deviceId: r.deviceId,
        message: `Rejected traffic for ${r.deviceId ?? r.topic}: ${r.reason}`,
        data: { reason: r.reason },
      });
    });

    this.timer = setInterval(() => this.checkSilence(), 1000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private checkSilence(): void {
    const now = Date.now();
    for (const id of DEVICE_IDS) {
      const last = this.lastTelemetry.get(id);
      if (last && now - last > SILENCE_TIMEOUT_MS) {
        void this.alerts.raise(`device_silent:${id}`, {
          type: 'device_offline', severity: 'critical', deviceId: id,
          message: `No telemetry from ${id} for ${Math.round((now - last) / 1000)} s`,
        });
      }
    }
    for (const [key, t] of this.lastRejection) {
      if (now - t > SECURITY_QUIET_MS) {
        this.lastRejection.delete(key);
        void this.alerts.resolve(key, 'no rejected traffic for 30 s');
      }
    }
  }
}
