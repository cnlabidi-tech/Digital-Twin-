/**
 * TwinEngine - connects TwinCore to the rest of the platform:
 *   bus 'telemetry' -> core.ingest/step -> bus 'twin' (dashboard)
 *                                       -> alerts (raise / resolve)
 *                                       -> twin_state table (1 Hz)
 *   learned model  -> twin_model table (survives restarts)
 *   'loss_confirmed' is re-emitted for the control module (auto pump stop, Phase 5).
 */
import { EventEmitter } from 'node:events';
import { bus } from '../bus';
import type { AlertService } from '../alerts/service';
import { pool } from '../db/pool';
import { TwinCore, type Intent, type TwinState } from './core';
import type { ModelParams } from './model';

type Log = { info: (m: string) => void; error: (m: string) => void };

export class TwinEngine extends EventEmitter {
  core = new TwinCore();
  last: TwinState | null = null;
  private lastRaised = new Map<string, string>();
  private lastPersist = 0;
  /** Data-integrity gate installed by the security module (Phase 6). */
  accept: (deviceId: string) => boolean = () => true;

  constructor(private readonly alerts: AlertService, private readonly log: Log) {
    super();
  }

  async start(): Promise<void> {
    const { rows } = await pool.query<{ params: ModelParams }>('SELECT params FROM twin_model WHERE active LIMIT 1');
    if (rows[0]) {
      this.core = new TwinCore(rows[0].params);
      this.log.info('twin: model loaded from database');
    } else {
      this.log.info('twin: no model yet, will learn a baseline');
    }
    bus.on('telemetry', ({ msg }) => {
      if (!this.accept(msg.deviceId)) return;
      this.core.ingest(msg);
      const out = this.core.step();
      if (!out) return;
      this.last = out.state;
      bus.emit('twin', out.state);
      for (const i of out.intents) void this.apply(i);
      if (out.state.ts - this.lastPersist >= 1000) {
        this.lastPersist = out.state.ts;
        void this.persist(out.state);
      }
    });
  }

  /** Discard the model and learn a new baseline. */
  async relearn(by: string): Promise<void> {
    this.core.relearn();
    await this.alerts.event('system', 'info', `Twin baseline re-learning requested by ${by}`);
  }

  private async apply(i: Intent): Promise<void> {
    switch (i.op) {
      case 'raise': {
        // Avoid re-sending identical alerts every step.
        const sig = `${i.alert.type}|${i.alert.severity}|${i.alert.message}`;
        if (this.lastRaised.get(i.key) === sig && this.alerts.isOpen(i.key)) return;
        this.lastRaised.set(i.key, sig);
        await this.alerts.raise(i.key, i.alert);
        return;
      }
      case 'resolve':
        this.lastRaised.delete(i.key);
        await this.alerts.resolve(i.key, i.note);
        return;
      case 'event':
        await this.alerts.event('system', i.severity, i.message, undefined, i.data);
        return;
      case 'learned':
        try {
          await pool.query('UPDATE twin_model SET active = false WHERE active');
          await pool.query('INSERT INTO twin_model (params) VALUES ($1)', [JSON.stringify(i.params)]);
        } catch (e) {
          this.log.error(`twin: cannot save model: ${(e as Error).message}`);
        }
        return;
      case 'loss_confirmed':
        this.emit('loss_confirmed', i);
        return;
    }
  }

  private async persist(s: TwinState): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO twin_state (time, mode, loss_lpm, z, cusum_pos, cusum_neg, hypothesis, segment, position_m, suspects)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [new Date(s.ts), s.mode, s.loss?.lpm ?? null, s.z ? JSON.stringify(s.z) : null, s.cusum.pos, s.cusum.neg,
          s.diagnosis?.hypothesis ?? null, s.location?.segment ?? null, s.location?.positionM ?? null, s.diagnosis?.suspects ?? null],
      );
    } catch (e) {
      this.log.error(`twin: persist failed: ${(e as Error).message}`);
    }
  }
}
