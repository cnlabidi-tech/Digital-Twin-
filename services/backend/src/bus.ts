/**
 * In-process event bus connecting the backend modules (modular monolith):
 *   ingestion --telemetry/status/ack--> twin, detection, control, API (WebSocket)
 * Typed wrapper around Node's EventEmitter.
 */
import { EventEmitter } from 'node:events';
import type { Ack, Status, Telemetry } from '@twin/contracts';

export interface Received<T> {
  msg: T;
  receivedAt: number;
  /** Raw text as received (needed to verify signatures). */
  raw: string;
  signed: boolean;
}

export interface Rejection {
  time: number;
  topic: string;
  deviceId?: string;
  channel?: string;
  reason: string;
  details?: unknown;
  raw?: string;
}

export interface BusEvents {
  telemetry: [Received<Telemetry>];
  status: [Received<Status>];
  ack: [Received<Ack>];
  rejected: [Rejection];
}

class TypedBus extends EventEmitter {
  override emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof BusEvents>(event: K, listener: (...args: BusEvents[K]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
}

export const bus = new TypedBus();
bus.setMaxListeners(50);
