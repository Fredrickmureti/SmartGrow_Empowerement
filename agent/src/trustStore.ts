/**
 * Phase 4.2.7c — OS trust-store integration for the loopback certificate.
 *
 * The per-install loopback cert (`tls.ts`) is self-signed. A browser
 * will refuse `https://127.0.0.1:8443` until that certificate is trusted
 * by the operating system. Every mature desktop connector solves this
 * the same way: ship the cert, then offer a one-click, explicitly
 * operator-initiated trust install (Zebra Browser Print, Epson ePOS and
 * the Square/Lightspeed peripheral bridges all do exactly this).
 *
 * Design rules this module holds to:
 *
 *  1. **Never implicit.** Nothing here runs on boot. It is only reachable
 *     through the `install_cert` / `uninstall_cert` supervisor ops, which
 *     the tray app exposes behind a labelled button.
 *  2. **Show your work.** `describeTrustCommands()` returns the exact
 *     argv that will be executed so the UI can render it before the
 *     operator consents. No hidden privilege escalation.
 *  3. **No shell.** Every invocation uses `execFile` with an argv array —
 *     never a concatenated shell string — so a path containing spaces or
 *     shell metacharacters cannot become command injection.
 *  4. **Honest failure.** A non-zero exit or a missing tool is reported
 *     verbatim to the operator rather than swallowed. Trust installs
 *     legitimately fail (no admin rights, locked-down SOE) and the
 *     correct product behaviour is to say so and keep using the relay.
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
  /** Non-fatal steps (e.g. the Chrome NSS DB may not exist). */
  optional?: boolean;
}

export interface TrustResult {
  ok: boolean;
  platform: NodeJS.Platform;
  certPath: string;
  /** Per-step outcome, in execution order. */
  steps: Array<{ command: string; ok: boolean; output: string }>;
  error?: string;
}

/**
 * Stable friendly name used for the Windows store entry and the Linux
 * ca-certificates filename, so uninstall can find what install created.
 */
const CERT_NICKNAME = 'AccrualFlow Edge Loopback';
const LINUX_CA_FILENAME = 'accrualflow-edge-loopback.crt';

function nssDbPath(): string {
  return `sql:${path.join(os.homedir(), '.pki', 'nssdb')}`;
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
    return action === 'install'
      ? [{
          file: 'certutil',
          args: ['-addstore', '-f', 'Root', certPath],
          explain: 'Adds the loopback certificate to the Windows Trusted Root store for this machine.',
          elevates: true,
        }]
      : [{
          file: 'certutil',
          args: ['-delstore', 'Root', CERT_NICKNAME],
          explain: 'Removes the loopback certificate from the Windows Trusted Root store.',
          elevates: true,
        }];
  }

  if (platform === 'darwin') {
    return action === 'install'
      ? [{
          file: 'security',
          args: [
            'add-trusted-cert', '-d', '-r', 'trustRoot',
            '-k', '/Library/Keychains/System.keychain', certPath,
          ],
          explain: 'Adds the loopback certificate to the macOS System keychain as a trusted root.',
          elevates: true,
        }]
      : [{
          file: 'security',
          args: ['remove-trusted-cert', '-d', certPath],
          explain: 'Removes the loopback certificate from the macOS System keychain.',
          elevates: true,
        }];
  }

  // Linux: the system CA bundle covers curl/openssl consumers; Chrome and
  // Chromium read a separate per-user NSS database, so both are needed for
  // the browser transport to actually work.
  const systemTarget = path.join('/usr/local/share/ca-certificates', LINUX_CA_FILENAME);
  if (action === 'install') {
    return [
      {
        file: 'cp',
        args: [certPath, systemTarget],
        explain: 'Copies the loopback certificate into the system CA directory.',
        elevates: true,
      },
      {
        file: 'update-ca-certificates',
        args: [],
        explain: 'Rebuilds the system CA bundle.',
        elevates: true,
      },
      {
        file: 'certutil',
        args: ['-d', nssDbPath(), '-A', '-t', 'C,,', '-n', CERT_NICKNAME, '-i', certPath],
        explain: 'Trusts the certificate in the per-user Chrome/Chromium certificate database.',
        elevates: false,
        optional: true,
      },
    ];
  }
  return [
    {
      file: 'rm',
      args: ['-f', systemTarget],
      explain: 'Removes the loopback certificate from the system CA directory.',
      elevates: true,
    },
    {
      file: 'update-ca-certificates',
      args: ['--fresh'],
      explain: 'Rebuilds the system CA bundle.',
      elevates: true,
    },
    {
      file: 'certutil',
      args: ['-d', nssDbPath(), '-D', '-n', CERT_NICKNAME],
      explain: 'Removes the certificate from the per-user Chrome/Chromium database.',
      elevates: false,
      optional: true,
    },
  ];
}

function run(cmd: TrustCommand): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, 2000);
      resolve({ ok: !err, output: output || (err ? String(err.message) : 'ok') });
    });
  });
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
    return { ...result, ok: false, error: 'cert_not_found' };
  }

  const commands = describeTrustCommands(action, process.platform, certPath);
  if (commands.length === 0) {
    return { ...result, ok: false, error: `unsupported_platform:${process.platform}` };
  }

  for (const cmd of commands) {
    const { ok, output } = await run(cmd);
    result.steps.push({ command: `${cmd.file} ${cmd.args.join(' ')}`, ok, output });
    if (!ok && !cmd.optional) {
      result.ok = false;
      result.error = `step_failed:${cmd.file}`;
      break;
    }
  }

  logger.info('trust_store_' + action, { ok: result.ok, platform: process.platform });
  return result;
}

/**
 * Best-effort read of whether the loopback cert is currently trusted.
 *
 * There is no portable API for this, so we do the honest thing: report
 * the fingerprint we would look for plus whatever the platform's query
 * command says. The tray app treats `unknown` as "not yet trusted" and
 * still offers the install button — an idempotent re-install is
 * harmless on all three platforms.
 */
export async function queryTrustStore(): Promise<{ trusted: boolean | null; detail: string }> {
  const certPath = LOOPBACK_CERT_PATH;
  if (!fs.existsSync(certPath)) return { trusted: false, detail: 'cert_not_found' };

  const pem = fs.readFileSync(certPath, 'utf8');
  const fingerprint = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

  if (process.platform === 'win32') {
    const r = await run({ file: 'certutil', args: ['-store', 'Root'], explain: '', elevates: false });
    return { trusted: r.ok ? r.output.toLowerCase().includes(fingerprint) : null, detail: r.ok ? 'queried' : r.output };
  }
  if (process.platform === 'darwin') {
    const r = await run({
      file: 'security',
      args: ['find-certificate', '-c', 'AccrualFlow Edge', '-Z', '/Library/Keychains/System.keychain'],
      explain: '', elevates: false,
    });
    return { trusted: r.ok ? r.output.toLowerCase().includes(fingerprint.slice(0, 40)) : false, detail: r.ok ? 'queried' : r.output };
  }
  const systemTarget = path.join('/usr/local/share/ca-certificates', LINUX_CA_FILENAME);
  return { trusted: fs.existsSync(systemTarget), detail: systemTarget };
}

export { CERT_NICKNAME, LINUX_CA_FILENAME };
