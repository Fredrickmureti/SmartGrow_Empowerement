/**
 * WinSpoolerTransport — Windows print transport via the user spooler.
 *
 * Implementation uses PowerShell as the broker because (a) it ships
 * with every supported Windows build, (b) it exposes the spooler via
 * `Out-Printer` and the Win32_Printer WMI surface for enumeration,
 * and (c) it lets us avoid binding to printui.dll / winspool.drv from
 * native code, which would make the Electron packager unhappy.
 *
 * For raw ESC/POS we cannot use `Out-Printer` (it formats text). The
 * raw path writes to a temp file and submits via `Copy-Item ... -Destination`
 * to the printer share, which is the standard PoSh raw idiom and what
 * the spooler ultimately exposes to USB-class-7 printers.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WinSpoolTarget {
  /** Printer name as shown in `Get-Printer`. */
  printer: string;
  /** Job timeout in ms (default 10_000). */
  timeoutMs?: number;
}

export interface WinSpoolSendResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

export type PowerShellRunner = (
  script: string,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

async function defaultPwsh(script: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    // Prefer PowerShell 7 (`pwsh`) when present; fall back to Windows PowerShell 5.1.
    const exe = process.env.LOVABLE_POSH_EXE || 'powershell.exe';
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

let _pwsh: PowerShellRunner = defaultPwsh;
export function __setWinSpoolRunner(r: PowerShellRunner | null): void {
  _pwsh = r ?? defaultPwsh;
}

function quotePosh(s: string): string {
  // Single-quote PoSh literal — escape embedded single-quotes by doubling them.
  return `'${s.replace(/'/g, "''")}'`;
}

export const WinSpoolerTransport = {
  async list(): Promise<{ printer: string; default?: boolean }[]> {
    if (process.platform !== 'win32') return [];
    const script = `Get-Printer | Select-Object Name,Default | ConvertTo-Json -Compress`;
    const res = await _pwsh(script, 5_000);
    if (res.code !== 0) return [];
    try {
      const raw = JSON.parse(res.stdout || '[]');
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.map((p: { Name: string; Default?: boolean }) => ({
        printer: p.Name,
        default: !!p.Default,
      }));
    } catch {
      return [];
    }
  },

  async send(target: WinSpoolTarget, bytes: Buffer | number[]): Promise<WinSpoolSendResult> {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'winspool unavailable on non-Windows' };
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const timeout = target.timeoutMs ?? 10_000;
    // Tempfile path keeps raw bytes intact — PowerShell pipelines coerce to string.
    const tmp = join(tmpdir(), `pos-spool-${randomUUID()}.prn`);
    try {
      await writeFile(tmp, buf);
      // Send raw bytes through the spooler. `Out-Printer` formats text, which
      // would mangle ESC/POS — we use the .NET RawPrinterHelper path instead.
      const script = `
$ErrorActionPreference = 'Stop';
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RPH {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOA { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h, Int32 l, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, IntPtr b, Int32 c, out Int32 w);
  public static bool SendBytes(string printer, byte[] bytes) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;
    var di = new DOCINFOA { pDocName = "POS Raw", pDataType = "RAW" };
    if (!StartDocPrinter(h, 1, di)) { ClosePrinter(h); return false; }
    if (!StartPagePrinter(h)) { EndPagePrinter(h); ClosePrinter(h); return false; }
    var ptr = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, ptr, bytes.Length);
    Int32 w; var ok = WritePrinter(h, ptr, bytes.Length, out w);
    Marshal.FreeCoTaskMem(ptr);
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h); return ok;
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes(${quotePosh(tmp)});
$ok = [RPH]::SendBytes(${quotePosh(target.printer)}, $bytes);
if (-not $ok) { Write-Error 'WritePrinter failed'; exit 2 }
`.trim();
      const res = await _pwsh(script, timeout);
      if (res.code === 0) return { ok: true, bytes: buf.length };
      return { ok: false, error: (res.stderr || res.stdout || `pwsh exited ${res.code}`).trim() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      try { await unlink(tmp); } catch { /* file may not exist */ }
    }
  },

  async test(target: WinSpoolTarget): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'win32') return { ok: false, error: 'winspool unavailable on non-Windows' };
    const script = `Get-Printer -Name ${quotePosh(target.printer)} | Select-Object PrinterStatus | ConvertTo-Json -Compress`;
    const res = await _pwsh(script, 3_000);
    if (res.code === 0) return { ok: true };
    return { ok: false, error: (res.stderr || res.stdout || `pwsh exited ${res.code}`).trim() };
  },

  isAvailable(): boolean { return process.platform === 'win32'; },

  async disconnect(_t: WinSpoolTarget): Promise<void> { /* nothing to release */ },
};
