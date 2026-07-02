/**
 * MockDriver — deterministic in-memory driver for tests and dev fallback.
 *
 * Records every `handle()` call so tests can assert dispatch order and
 * payload shape. `connect/disconnect/healthCheck` always succeed.
 */

import { BaseDriver, type DriverHealth } from './IDriver';
import type { DeviceRole, ExecCommand, ExecResult } from '../types';

export interface MockHandled {
  op: string;
  payload: unknown;
  idempotencyKey: string;
  at: number;
}

export class MockDriver extends BaseDriver {
  readonly role: DeviceRole;
  readonly handled: MockHandled[] = [];
  private readonly ops: readonly string[];

  constructor(role: DeviceRole, ops: readonly string[] = ['*']) {
    super();
    this.role = role;
    this.ops = ops;
  }

  supportedOps(): readonly string[] { return this.ops; }

  protected async onHealthCheck(): Promise<DriverHealth> {
    return { ok: true, latencyMs: 0 };
  }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    this.handled.push({ op: cmd.op, payload: cmd.payload, idempotencyKey: cmd.idempotencyKey, at: Date.now() });
    return { ok: true, result: { mock: true, op: cmd.op } };
  }
}
