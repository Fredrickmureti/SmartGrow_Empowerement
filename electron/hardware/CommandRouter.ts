/**
 * CommandRouter — the only sanctioned IPC entry point for hardware operations.
 *
 * Registered in `electron/main.ts` as `ipcMain.handle('pos:exec', …)`.
 * Validates every payload against {@link ExecCommandSchema}, denies unknown
 * roles/ops, audits every call, and dispatches via a pluggable handler
 * registry so drivers can be moved into main one at a time without
 * touching the renderer.
 *
 * This file deliberately has zero `node-usb` / `serialport` imports so it
 * can be unit-tested in the Vitest jsdom environment alongside the
 * renderer tests.
 */

import type { DeviceRole, ExecCommand, ExecResult } from './types';
import { HARDWARE_ROLES } from './types';

/** Pure validator — avoids a Zod dep in the Electron bundle for now. */
export function validateExecCommand(input: unknown): { ok: true; cmd: ExecCommand } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'payload must be an object' };
  const o = input as Record<string, unknown>;
  if (typeof o.role !== 'string' || !(HARDWARE_ROLES as readonly string[]).includes(o.role)) {
    return { ok: false, error: `invalid role: ${String(o.role)}` };
  }
  if (typeof o.op !== 'string' || o.op.length === 0 || o.op.length > 64) {
    return { ok: false, error: 'invalid op' };
  }
  if (typeof o.idempotencyKey !== 'string' || o.idempotencyKey.length < 8 || o.idempotencyKey.length > 128) {
    return { ok: false, error: 'invalid idempotencyKey' };
  }
  if (o.maxAttempts !== undefined) {
    if (typeof o.maxAttempts !== 'number' || o.maxAttempts < 1 || o.maxAttempts > 10) {
      return { ok: false, error: 'maxAttempts must be 1..10' };
    }
  }
  return {
    ok: true,
    cmd: {
      role: o.role as DeviceRole,
      op: o.op,
      payload: o.payload,
      idempotencyKey: o.idempotencyKey,
      maxAttempts: o.maxAttempts as number | undefined,
    },
  };
}

export type OpHandler = (cmd: ExecCommand) => Promise<ExecResult>;

/** Registry of `role:op` → handler. */
export class CommandRouter {
  private handlers = new Map<string, OpHandler>();
  private audit: ((cmd: ExecCommand, res: ExecResult) => void) | undefined;
  /**
   * Audit Wave 9d.9 (P4 #19) — when set, every exec is wrapped in
   * `roleLock(role, fn)` so that command dispatch serializes against
   * health probes on the same physical device. DeviceManager installs
   * itself here at bootstrap.
   */
  private roleLock: (<T>(role: DeviceRole, fn: () => Promise<T>) => Promise<T>) | undefined;

  constructor(opts?: {
    audit?: (cmd: ExecCommand, res: ExecResult) => void;
    roleLock?: <T>(role: DeviceRole, fn: () => Promise<T>) => Promise<T>;
  }) {
    this.audit = opts?.audit;
    this.roleLock = opts?.roleLock;
  }

  /** Install / replace the per-role mutex. Called by DeviceManager. */
  setRoleLock(fn: <T>(role: DeviceRole, fn: () => Promise<T>) => Promise<T>): void {
    this.roleLock = fn;
  }

  /** Register a handler for a `role:op` pair. Throws on duplicate registration. */
  register(role: DeviceRole, op: string, handler: OpHandler): void {
    const key = `${role}:${op}`;
    if (this.handlers.has(key)) {
      throw new Error(`CommandRouter: duplicate handler for ${key}`);
    }
    this.handlers.set(key, handler);
  }

  hasHandler(role: DeviceRole, op: string): boolean {
    return this.handlers.has(`${role}:${op}`);
  }

  /**
   * Distinct roles that currently have at least one handler registered.
   * Used by the main-process queue tick loop so adding a new role no
   * longer requires editing a static array (Audit Wave 9d.7 P4).
   */
  registeredRoles(): DeviceRole[] {
    const set = new Set<DeviceRole>();
    for (const key of this.handlers.keys()) {
      const role = key.split(':', 1)[0] as DeviceRole;
      set.add(role);
    }
    return Array.from(set);
  }

  async exec(rawInput: unknown): Promise<ExecResult> {
    const parsed = validateExecCommand(rawInput);
    if (parsed.ok === false) return { ok: false, error: parsed.error };
    const cmd = parsed.cmd;
    const handler = this.handlers.get(`${cmd.role}:${cmd.op}`);
    if (!handler) {
      const res: ExecResult = { ok: false, error: `unknown op: ${cmd.role}:${cmd.op}` };
      this.audit?.(cmd, res);
      return res;
    }
    const run = async (): Promise<ExecResult> => {
      try {
        const res = await handler(cmd);
        this.audit?.(cmd, res);
        return res;
      } catch (err) {
        const res: ExecResult = { ok: false, error: (err as Error).message };
        this.audit?.(cmd, res);
        return res;
      }
    };
    return this.roleLock ? this.roleLock(cmd.role, run) : run();
  }

  /** Test helper: clear all registrations. */
  _reset(): void { this.handlers.clear(); }
}

/** Process-wide singleton used by `ipcMain.handle('pos:exec', …)`. */
export const commandRouter = new CommandRouter();
