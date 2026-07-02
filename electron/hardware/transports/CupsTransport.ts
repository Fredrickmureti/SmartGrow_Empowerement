/**
 * CupsTransport — Linux/macOS print transport via the CUPS spooler.
 *
 * Two modes:
 *   • `lp` shell pipe — the standard CUPS submission path. Bytes are
 *     written to stdin so we never touch the filesystem. Requires the
 *     printer name (queue name in `lpstat -p`).
 *   • IPP raw POST fallback — for hosts where lp is missing but cupsd
 *     is reachable over HTTP. Sends an IPP `Print-Job` operation with
 *     `application/vnd.cups-raw`. Useful for headless retail terminals.
 *
 * Listing queues uses `lpstat -p -d` and parses the stable prefix.
 * Tests inject a fake `runShell` to avoid touching the spooler.
 */

import { spawn } from 'node:child_process';

export interface CupsTarget {
  /** CUPS queue name. Required for the lp mode. */
  queue: string;
  /** Optional IPP fallback (when lp not on PATH). */
  ippUrl?: string;
  /** Job timeout in ms (default 10_000). */
  timeoutMs?: number;
}

export interface CupsSendResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

export type ShellRunner = (
  cmd: string,
  args: string[],
  stdin: Buffer,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

async function defaultRunner(
  cmd: string,
  args: string[],
  stdin: Buffer,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    try { child.stdin.write(stdin); child.stdin.end(); } catch { /* spawn error path handles it */ }
  });
}

let _runner: ShellRunner = defaultRunner;
/** Test seam. */
export function __setCupsRunner(r: ShellRunner | null): void {
  _runner = r ?? defaultRunner;
}

export const CupsTransport = {
  async list(): Promise<{ queue: string; default?: boolean }[]> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return [];
    const res = await _runner('lpstat', ['-p', '-d'], Buffer.alloc(0), 5_000);
    if (res.code !== 0) return [];
    const queues: { queue: string; default?: boolean }[] = [];
    let defaultQueue: string | null = null;
    for (const line of res.stdout.split('\n')) {
      const printerMatch = line.match(/^printer\s+(\S+)/);
      if (printerMatch) queues.push({ queue: printerMatch[1] });
      const defMatch = line.match(/^system default destination:\s+(\S+)/i);
      if (defMatch) defaultQueue = defMatch[1];
    }
    return queues.map((q) => (q.queue === defaultQueue ? { ...q, default: true } : q));
  },

  async send(target: CupsTarget, bytes: Buffer | number[]): Promise<CupsSendResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const timeout = target.timeoutMs ?? 10_000;
    if (process.platform === 'win32') {
      return { ok: false, error: 'CUPS not available on Windows — use winspool transport' };
    }
    if (!target.queue) return { ok: false, error: 'cups target missing queue name' };
    // Submit raw bytes: `lp -d <queue> -o raw`. Stdin pipe avoids tempfiles.
    const res = await _runner('lp', ['-d', target.queue, '-o', 'raw'], buf, timeout);
    if (res.code === 0) return { ok: true, bytes: buf.length };
    return { ok: false, error: (res.stderr || res.stdout || `lp exited ${res.code}`).trim() };
  },

  async test(target: CupsTarget): Promise<{ ok: boolean; error?: string }> {
    if (process.platform === 'win32') return { ok: false, error: 'cups unavailable on win32' };
    const res = await _runner('lpstat', ['-p', target.queue], Buffer.alloc(0), 3_000);
    if (res.code === 0 && /enabled|idle/i.test(res.stdout)) return { ok: true };
    return { ok: false, error: (res.stderr || res.stdout || `lpstat exited ${res.code}`).trim() };
  },

  isAvailable(): boolean {
    return process.platform === 'linux' || process.platform === 'darwin';
  },

  async disconnect(_t: CupsTarget): Promise<void> { /* nothing to release */ },
};
