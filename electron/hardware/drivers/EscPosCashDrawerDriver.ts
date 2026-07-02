/**
 * EscPosCashDrawerDriver — RJ-11 drawer attached to a receipt printer.
 *
 * Most cash drawers daisy-chain off the receipt printer's drawer port
 * (RJ-11/12); the standard kick command is `ESC p m t1 t2` where
 * `m` is the pin (0 = pin 2, 1 = pin 5). 25/250 ms on/off timings match
 * the OPOS recommendation that's been stable since the 90s — virtually
 * every ESC/POS-compatible drawer responds correctly.
 */

import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';

function kickBytes(pin: 2 | 5 = 2): Buffer {
  // ESC p m=(0|1) t1 t2 — pulses pin 2 or pin 5 of the drawer port.
  const m = pin === 5 ? 1 : 0;
  return Buffer.from([0x1B, 0x70, m, 25, 250]);
}

export class EscPosCashDrawerDriver extends TransportDriver {
  readonly role: DeviceRole = 'cash_drawer';

  supportedOps(): readonly string[] { return ['open']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'open') {
      return { ok: false, error: `unsupported op '${cmd.op}' on cash_drawer` };
    }
    const payload = (cmd.payload ?? {}) as { pin?: 2 | 5 };
    const r = await this.send(kickBytes(payload.pin ?? 2));
    return r.ok ? { ok: true, result: 'kicked' } : r;
  }
}
