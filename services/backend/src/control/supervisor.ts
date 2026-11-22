/**
 * Supervisor - automatic actions and safety interlocks.
 *
 * Automatic:
 *   - confirmed LEAK  -> stop the pump (policy auto_stop_on_leak)
 *   - confirmed THEFT -> stop the pump (policy auto_stop_on_theft)
 *
 * Interlocks (security by design):
 *   - NO automatic action while the data-integrity alarm is open: otherwise an
 *     attacker could inject false data that "looks like" a leak and use the
 *     twin itself to shut the pipeline down (denial of service through FDI).
 *     The operator is told to inspect instead.
 *   - Restarting the pump while a loss alert is open requires force=true
 *     (admin role once authentication exists, Phase 6).
 */
import type { CommandType, DeviceId } from '@twin/contracts';
import type { AlertService } from '../alerts/service';
import { pool } from '../db/pool';
import type { TwinEngine } from '../twin/engine';
import type { CommandService } from './commands';

export interface Policy {
  autoStopOnLeak: boolean;
  autoStopOnTheft: boolean;
}

export class InterlockError extends Error {
  status = 409;
}

export class Supervisor {
  policy: Policy = { autoStopOnLeak: true, autoStopOnTheft: true };

  constructor(
    private readonly commands: CommandService,
    private readonly twin: TwinEngine,
    private readonly alerts: AlertService,
  ) {}

  async start(): Promise<void> {
    const { rows } = await pool.query('SELECT * FROM control_policy WHERE id = 1');
    if (rows[0]) this.policy = { autoStopOnLeak: rows[0].auto_stop_on_leak, autoStopOnTheft: rows[0].auto_stop_on_theft };

    this.twin.on('loss_confirmed', (i: { kind: 'leak' | 'theft'; segment?: string; lossLpm: number }) => void this.onLoss(i));
  }

  private async onLoss(i: { kind: 'leak' | 'theft'; segment?: string; lossLpm: number }): Promise<void> {
    const wanted = i.kind === 'leak' ? this.policy.autoStopOnLeak : this.policy.autoStopOnTheft;
    if (!wanted) {
      await this.alerts.event('command', 'warning', `Confirmed ${i.kind}: automatic stop disabled by policy - operator action required`);
      return;
    }
    if (this.twin.core.integrityAlert) {
      await this.alerts.event('command', 'critical', `Confirmed ${i.kind} but data integrity is in doubt: automatic stop BLOCKED, inspect the pipe`);
      return;
    }
    await this.alerts.event('command', 'critical', `Confirmed ${i.kind} (${i.lossLpm.toFixed(2)} L/min, segment ${i.segment ?? '?'}): stopping pump automatically`);
    await this.commands.send('node-inlet', 'pump.set', { on: false }, `auto:twin`);
  }

  /** Manual command from the dashboard, with interlocks. */
  async manual(deviceId: DeviceId, type: CommandType, params: Record<string, unknown>, user: string, force = false) {
    const starting = deviceId === 'node-inlet' && type === 'pump.set' && params.on === true;
    if (starting && this.alerts.isOpen('loss') && !force) {
      throw new InterlockError('A leak/theft alert is open: confirm the pipe was repaired (force) before restarting the pump');
    }
    if (force) await this.alerts.event('command', 'warning', `${user} overrode the interlock for ${type}`, deviceId);
    return this.commands.send(deviceId, type, params, `user:${user}`);
  }

  async setPolicy(p: Partial<Policy>, user: string): Promise<Policy> {
    this.policy = { ...this.policy, ...p };
    await pool.query(
      'UPDATE control_policy SET auto_stop_on_leak=$1, auto_stop_on_theft=$2, updated_at=now(), updated_by=$3 WHERE id=1',
      [this.policy.autoStopOnLeak, this.policy.autoStopOnTheft, user],
    );
    await this.alerts.event('command', 'info', `${user} set control policy ${JSON.stringify(this.policy)}`);
    return this.policy;
  }
}
