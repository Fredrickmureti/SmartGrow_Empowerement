/**
 * SerialScaleDriver — weighing scale over RS-232.
 *
 * Frame protocols (selectable via assignment.config.protocol):
 *   - 'generic' (default) — first CR/LF-terminated frame wins; the
 *     scale's own ASCII format is returned verbatim for the caller to
 *     parse. Matches NCI SCP-01, CAS PD-II, Mettler SICS.
 *   - 'poll' — sends a trigger byte (default 'W\r') then reads one frame.
 *
 * `read_weight` payload:
 *   - timeoutMs?: number (default 1500)
 *   - pollCommand?: number[] (override trigger; pass [] to disable)
 *
 * Returns `{ frame: string, transport: 'serial' }` so the renderer can
 * pick the protocol-specific parser. The driver intentionally does NOT
 * decode the value — different sites use different units / decimal
 * placements and the parser already lives in scale-protocol modules
 * shared with the BrowserHardwareAdapter.
 */

import { TransportDriver } from './TransportDriver';
import type { ExecCommand, ExecResult, DeviceRole } from '../types';
import { SerialTransport } from '../transports/SerialTransport';

export class SerialScaleDriver extends TransportDriver {
  readonly role: DeviceRole = 'scale';

  supportedOps(): readonly string[] { return ['read_weight']; }

  async handle(cmd: ExecCommand): Promise<ExecResult> {
    if (cmd.op !== 'read_weight') {
      return { ok: false, error: `unsupported op '${cmd.op}' on scale` };
    }
    if (this.assignment.transport !== 'serial') {
      return { ok: false, error: `scale:read_weight requires serial transport, got '${this.assignment.transport}'` };
    }
    const cfg = this.cfg();
    const path = String(cfg.path ?? '');
    const baudRate = Number(cfg.baudRate ?? 9600);
    if (!path) return { ok: false, error: 'serial scale missing path' };
    const payload = (cmd.payload ?? {}) as { pollCommand?: number[]; timeoutMs?: number };
    const timeoutMs = Number(payload.timeoutMs ?? 1500);
    const openOpts = {
      path, baudRate,
      dataBits: cfg.dataBits as 5 | 6 | 7 | 8 | undefined,
      stopBits: cfg.stopBits as 1 | 1.5 | 2 | undefined,
      parity: cfg.parity as 'none' | 'even' | 'odd' | 'mark' | 'space' | undefined,
      idleCloseMs: (cfg.idleCloseMs as number | undefined) ?? 30_000,
    };
    const trigger = Array.isArray(payload.pollCommand)
      ? (payload.pollCommand.length > 0 ? Buffer.from(payload.pollCommand) : null)
      : null;

    try {
      let buffered = '';
      let resolveFrame: ((frame: string) => void) | null = null;
      const unsubscribe = await SerialTransport.subscribe(openOpts, (chunk) => {
        buffered += chunk.toString('ascii');
        const term = buffered.search(/[\r\n]/);
        if (term >= 0 && resolveFrame) {
          const frame = buffered.slice(0, term).trim();
          buffered = buffered.slice(term + 1);
          const r = resolveFrame; resolveFrame = null; r(frame);
        }
      });
      if (trigger) {
        const s = await SerialTransport.send(openOpts, trigger);
        if (!s.ok) { unsubscribe(); return { ok: false, error: s.error ?? 'scale trigger failed' }; }
      }
      const frame = await new Promise<string | null>((resolve) => {
        const t = setTimeout(() => { resolveFrame = null; resolve(null); }, timeoutMs);
        resolveFrame = (f) => { clearTimeout(t); resolve(f); };
      });
      unsubscribe();
      if (!frame) return { ok: false, error: 'scale read timeout' };
      return { ok: true, result: { frame, transport: 'serial' } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
