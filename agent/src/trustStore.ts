/**
 * Phase 4.2.7c — OS trust-store integration for the loopback certificate.
 *
 * The per-install loopback cert (`tls.ts`) is self-signed. A browser
 * will refuse `https://127.0.0.1:8443` until that certificate is trusted.
 *
 * Design rules this module holds to:
 *
 *  1. **Never implicit.** Nothing here runs on boot. It is only reachable
 *     through the `install_cert` / `uninstall_cert` supervisor ops.
 *  2. **Show your work.** `describeTrustCommands()` returns the exact
 *     argv that will be executed so the UI can render it before the
 *     operator consents. No hidden privilege escalation.
 *  3. **No shell.** Every invocation uses `execFile` with an argv array —
 *     never a concatenated shell string.
 *  4. **User scope first.** The store that actually decides whether a
 *     browser accepts the loopback origin is a per-user store on all three
 *     platforms (Windows CurrentUser\Root, the macOS login keychain, the
 *     Chrome/Chromium NSS DB on Linux). Those need no administrator
 *     rights, so they run first and decide success. Machine-wide steps
 *     (Linux `/usr/local/share/ca-certificates`) are best-effort: they are
 *     wrapped in a detected elevation helper (`pkexec`, or `sudo -n` when
 *     it is already cached) and never fail the operation.
 *  5. **Honest failure.** A non-zero exit or a missing tool is reported
 *     verbatim, together with an actionable hint.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { LOOPBACK_CERT_PATH } from './tls.js';

export type TrustPlatform = 'win32' | 'darwin' | 'linux';

export interface TrustCommand {
  /** Executable name, resolved on PATH. */
  file: string;
  args: string[];
  /** Human sentence rendered in the tray app next to the command. */
  explain: string;
  /** True when the OS will prompt for admin/root credentials. */
  elevates: boolean;
  /** Non-fatal steps (machine-wide extras, missing Chrome NSS DB, ...). */
  optional?: boolean;
}

export interface TrustResult {
  ok: boolean;
  platform: NodeJS.Platform;
  certPath: string;
  /** Per-step outcome, in execution order. */
  steps: Array<{ command: string; ok: boolean; output: string; optional?: boolean; skipped?: boolean }>;
  error?: string;
  /** Plain-language next step when something did not apply cleanly. */
  hint?: string;
}

/**
 * Stable friendly name used for the store entries and the Linux
 * ca-certificates filename, so uninstall can find what install created.
 */
const CERT_NICKNAME = 'AccrualFlow Edge Loopback';
const LINUX_CA_FILENAME = 'accrualflow-edge-loopback.crt';
const LINUX_SYSTEM_TARGET = path.join('/usr/local/share/ca-certificates', LINUX_CA_FILENAME);

function nssDir(): string {
  return path.join(os.homedir(), '.pki', 'nssdb');
}

function nssDbPath(): string {
  return `sql:${nssDir()}`;
}

function loginKeychain(): string {
  const dir = path.join(os.homedir(), 'Library', 'Keychains');
  const db = path.join(dir, 'login.keychain-db');
  return fs.existsSync(db) ? db : path.join(dir, 'login.keychain');
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function onPath(bin: string): string | null {
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Pick a non-interactive-safe elevation helper for machine-wide steps.
 * `pkexec` shows a graphical polkit prompt; `sudo -n` only succeeds when
 * the operator already has a cached/passwordless grant. When neither is
 * usable we simply do not offer the machine-wide steps — user-scope trust
 * is enough for the browser transport.
 */
export function detectElevator(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (platform !== 'linux' || isRoot()) return null;
  if (onPath('pkexec')) return { file: 'pkexec', args: [] };
  if (onPath('sudo')) return { file: 'sudo', args: ['-n'] };
  return null;
}

function elevate(cmd: TrustCommand, elevator: { file: string; args: string[] } | null): TrustCommand {
  if (!cmd.elevates || isRoot() || !elevator) return cmd;
  const resolved = onPath(cmd.file) ?? cmd.file;
  return { ...cmd, file: elevator.file, args: [...elevator.args, resolved, ...cmd.args] };
}

/**
 * Build the platform-appropriate command list. Pure — exported so the
 * tray app can preview commands and so unit tests can assert the argv
 * shape per platform without touching a real trust store.
 */
export function describeTrustCommands(
  action: 'install' | 'uninstall',
  platform: NodeJS.Platform,
  certPath: string = LOOPBACK_CERT_PATH,
): TrustCommand[] {
  if (platform === 'win32') {
    // `-user` writes CurrentUser\Root: no UAC prompt, and Edge/Chrome
    // honour it for the current operator, which is who runs the console.
    return action === 'install'
      ? [{
          file: 'certutil',
          args: ['-user', '-addstore', '-f', 'Root', certPath],
          explain: 'Trusts the loopback certificate for your Windows user account.',
          elevates: false,
        }]
      : [{
          file: 'certutil',
          args: ['-user', '-delstore', 'Root', CERT_NICKNAME],
          explain: 'Removes the loopback certificate from your Windows user trust store.',
          elevates: false,
        }];
  }

  if (platform === 'darwin') {
    // The login keychain needs consent, not administrator credentials.
    return action === 'install'
      ? [{
          file: 'security',
          args: ['add-trusted-cert', '-r', 'trustRoot', '-k', loginKeychain(), certPath],
          explain: 'Trusts the loopback certificate in your macOS login keychain.',
          elevates: false,
        }]
      : [{
          file: 'security',
          args: ['remove-trusted-cert', certPath],
          explain: 'Removes the loopback certificate from your macOS login keychain.',
          elevates: false,
        }];
  }

  // Linux: Chrome and Chromium read a per-user NSS database — that is the
  // step that makes the browser transport work, and it needs no root. The
  // system CA bundle (curl/openssl consumers) is a machine-wide bonus.
  const elevator = detectElevator(platform);
  if (action === 'install') {
    return [
      {
        file: 'certutil',
        args: ['-d', nssDbPath(), '-A', '-t', 'C,,', '-n', CERT_NICKNAME, '-i', certPath],
        explain: 'Trusts the certificate in your Chrome/Chromium certificate database.',
        elevates: false,
      },
      ...(elevator ? [
        {
          file: 'cp',
          args: [certPath, LINUX_SYSTEM_TARGET],
          explain: 'Also copies the certificate into the system CA directory (optional).',
          elevates: true,
          optional: true,
        },
        {
          file: 'update-ca-certificates',
          args: [],
          explain: 'Rebuilds the system CA bundle (optional).',
          elevates: true,
          optional: true,
        },
      ] : []),
    ].map((c) => elevate(c as TrustCommand, elevator));
  }
  return [
    {
      file: 'certutil',
      args: ['-d', nssDbPath(), '-D', '-n', CERT_NICKNAME],
      explain: 'Removes the certificate from your Chrome/Chromium certificate database.',
      elevates: false,
    },
    ...(elevator ? [
      {
        file: 'rm',
        args: ['-f', LINUX_SYSTEM_TARGET],
        explain: 'Removes the certificate from the system CA directory (optional).',
        elevates: true,
        optional: true,
      },
      {
        file: 'update-ca-certificates',
        args: ['--fresh'],
        explain: 'Rebuilds the system CA bundle (optional).',
        elevates: true,
        optional: true,
      },
    ] : []),
  ].map((c) => elevate(c as TrustCommand, elevator));
}

function run(cmd: TrustCommand): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, 2000);
      resolve({ ok: !err, output: output || (err ? String(err.message) : 'ok') });
    });
  });
}

/** Chrome's NSS database is created lazily by the browser; certutil needs it to exist. */
async function ensureNssDb(): Promise<void> {
  const dir = nssDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'cert9.db'))) {
    // An empty password DB is what Chrome itself creates.
    await run({ file: 'certutil', args: ['-d', nssDbPath(), '-N', '--empty-password'], explain: '', elevates: false });
  }
}

function hintFor(platform: NodeJS.Platform, failed: string): string {
  if (platform === 'linux' && failed === 'certutil') {
    return 'The `certutil` tool is missing. Install NSS tools (Debian/Ubuntu: sudo apt install libnss3-tools · Fedora: sudo dnf install nss-tools) and try again.';
  }
  if (platform === 'linux') {
    return 'The browser trust step did not apply. You can still use the Supabase relay, or import ~/.accrualflow/edge/tls/cert.pem manually via chrome://settings/certificates → Authorities.';
  }
  return 'The trust step did not apply. Review the step output below, or keep using the Supabase relay transport.';
}

/**
 * Execute the trust-store change. Returns a structured, per-step result
 * rather than throwing — the tray app renders every step so an operator
 * can hand the output to their IT team when a locked-down machine
 * refuses the install.
 */
export async function applyTrustStore(action: 'install' | 'uninstall'): Promise<TrustResult> {
  const certPath = LOOPBACK_CERT_PATH;
  const result: TrustResult = { ok: true, platform: process.platform, certPath, steps: [] };

  if (!fs.existsSync(certPath)) {
    return { ...result, ok: false, error: 'cert_not_found', hint: 'The agent has not minted a loopback certificate yet. Start the agent, then retry.' };
  }

  if (process.platform === 'linux' && action === 'install') await ensureNssDb();

  const commands = describeTrustCommands(action, process.platform, certPath);
  if (commands.length === 0) {
    return { ...result, ok: false, error: `unsupported_platform:${process.platform}` };
  }

  for (const cmd of commands) {
    const { ok, output } = await run(cmd);
    result.steps.push({ command: `${cmd.file} ${cmd.args.join(' ')}`, ok, output, optional: cmd.optional });
    if (!ok && !cmd.optional) {
      result.ok = false;
      result.error = `step_failed:${cmd.file}`;
      result.hint = hintFor(process.platform, cmd.file);
      break;
    }
  }

  logger.info('trust_store_' + action, { ok: result.ok, platform: process.platform });
  return result;
}

/**
 * Best-effort read of whether the loopback cert is currently trusted.
 *
 * There is no portable API for this, so we query the user-scope store that
 * decides browser behaviour and fall back to reporting what we looked for.
 * The tray app treats `null` as "not yet trusted" and still offers the
 * install button — an idempotent re-install is harmless everywhere.
 */
export async function queryTrustStore(): Promise<{ trusted: boolean | null; detail: string }> {
  const certPath = LOOPBACK_CERT_PATH;
  if (!fs.existsSync(certPath)) return { trusted: false, detail: 'No loopback certificate has been minted yet.' };

  const pem = fs.readFileSync(certPath, 'utf8');
  const fingerprint = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

  if (process.platform === 'win32') {
    const r = await run({ file: 'certutil', args: ['-user', '-store', 'Root'], explain: '', elevates: false });
    return {
      trusted: r.ok ? r.output.toLowerCase().includes(fingerprint) : null,
      detail: r.ok ? 'Checked your Windows user trust store.' : r.output,
    };
  }
  if (process.platform === 'darwin') {
    const r = await run({
      file: 'security',
      args: ['find-certificate', '-c', 'AccrualFlow Edge', '-Z', loginKeychain()],
      explain: '', elevates: false,
    });
    return {
      trusted: r.ok ? r.output.toLowerCase().includes(fingerprint.slice(0, 40)) : false,
      detail: r.ok ? 'Checked your macOS login keychain.' : r.output,
    };
  }

  const nss = await run({
    file: 'certutil',
    args: ['-d', nssDbPath(), '-L', '-n', CERT_NICKNAME],
    explain: '', elevates: false,
  });
  const system = fs.existsSync(LINUX_SYSTEM_TARGET);
  if (nss.ok) {
    return { trusted: true, detail: system ? 'Trusted for Chrome/Chromium and system-wide.' : 'Trusted for Chrome/Chromium on this account.' };
  }
  if (system) return { trusted: true, detail: 'Present in the system CA bundle.' };
  if (!onPath('certutil')) {
    return { trusted: false, detail: 'NSS tools not installed — install libnss3-tools (Debian/Ubuntu) or nss-tools (Fedora) to trust the certificate for Chrome.' };
  }
  return { trusted: false, detail: 'Not present in your Chrome/Chromium certificate database.' };
}

export { CERT_NICKNAME, LINUX_CA_FILENAME, LINUX_SYSTEM_TARGET };
