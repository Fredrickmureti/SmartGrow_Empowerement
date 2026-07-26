/**
 * Phase 4.2.6 — Service supervisor IPC.
 *
 * The AccrualFlow Edge runtime is designed to be hosted by a platform-native
 * service manager (Windows Service via node-windows, macOS LaunchAgent, Linux
 * systemd --user) so it survives user logout, laptop-lid-close, and reboots.
 * The Electron tray app then becomes a *client* of that service rather than
 * its parent. This module exposes the IPC surface that both the platform
 * installer scripts and the tray app use to talk to the runtime.
 *
 * Transport:
 *   - Windows:   named pipe   `\\.\pipe\accrualflow-edge`
 *   - POSIX:     unix socket  `~/.accrualflow/edge/supervisor.sock` (mode 0600)
 *
 * Wire format: newline-delimited JSON. Each request MUST include the token
 * from `~/.accrualflow/edge/supervisor.token` (32 hex bytes, mode 0600).
 * The token is generated on first boot; it is *not* the workstation secret
 * and never leaves the machine. This keeps the supervisor surface trivially
 * unreachable from any browser or off-box actor even if a curious sibling
 * process opens the pipe.
 *
 * Commands (all synchronous, single-shot):
 *   { op: 'ping' }                       -> { ok: true, pong: <ms> }
 *   { op: 'status' }                     -> { ok, version, uptime_s, pid,
 *                                              tls: { enabled, fingerprint },
 *                                              workstation_id }
 *   { op: 'reload_origins' }             -> { ok }        (kicks getAllowedOrigins refetch)
 *   { op: 'rotate_cert' }                -> { ok, fingerprint_sha256 }
 *   { op: 'cert_status' }                -> { ok, trusted, detail, commands }
 *   { op: 'install_cert' }               -> { ok, steps[] }   (OS trust store)
 *   { op: 'uninstall_cert' }             -> { ok, steps[] }
 *   { op: 'shutdown' }                   -> { ok }        (process.exit(0) after 200ms)
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { applyTrustStore, describeTrustCommands, queryTrustStore } from './trustStore.js';

const EDGE_HOME = path.join(os.homedir(), '.accrualflow', 'edge');
const TOKEN_PATH = path.join(EDGE_HOME, 'supervisor.token');
const SOCK_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\accrualflow-edge'
  : path.join(EDGE_HOME, 'supervisor.sock');

export interface SupervisorHooks {
  version: string;
  /**
   * Read lazily — the fingerprint changes when `rotate_cert` re-mints the
   * loopback certificate, and `status` must report the live value rather
   * than whatever was true at process start.
   */
  tlsFingerprint?: () => string | null;
  tlsEnabled: boolean;
  tlsPort?: number | null;
  workstationId?: string | null;
  onReloadOrigins?: () => Promise<void> | void;
  /** Re-mint the loopback cert and hot-swap it into the live listener. */
  onRotateCert?: () => Promise<string | null> | string | null;
}


function ensureToken(): string {
  fs.mkdirSync(EDGE_HOME, { recursive: true, mode: 0o700 });
  try {
    const cached = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    if (/^[a-f0-9]{64}$/i.test(cached)) return cached;
  } catch { /* generate below */ }
  const tok = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, tok, { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* windows: ignore */ }
  return tok;
}

export function startSupervisor(hooks: SupervisorHooks): () => void {
  const token = ensureToken();
  const startedAt = Date.now();

  // Clean stale POSIX socket left over from a crash — otherwise listen() EADDRINUSE.
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCK_PATH); } catch { /* not present */ }
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf-8');
    sock.on('data', async (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);

      let req: Record<string, unknown> = {};
      try { req = JSON.parse(line); } catch {
        sock.write(JSON.stringify({ ok: false, error: 'invalid_json' }) + '\n');
        sock.end();
        return;
      }

      const provided = typeof req.token === 'string' ? req.token : '';
      // Constant-time comparison to avoid timing side-channel on the local pipe.
      const ok = provided.length === token.length
        && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
      if (!ok) {
        logger.warn('supervisor_auth_failed', { op: req.op });
        sock.write(JSON.stringify({ ok: false, error: 'unauthorized' }) + '\n');
        sock.end();
        return;
      }

      const op = String(req.op ?? '');
      try {
        switch (op) {
          case 'ping':
            sock.write(JSON.stringify({ ok: true, pong: Date.now() }) + '\n');
            break;
          case 'status':
            sock.write(JSON.stringify({
              ok: true,
              version: hooks.version,
              pid: process.pid,
              uptime_s: Math.floor((Date.now() - startedAt) / 1000),
              tls: {
                enabled: hooks.tlsEnabled,
                fingerprint_sha256: hooks.tlsFingerprint ?? null,
                port: hooks.tlsPort ?? null,
              },
              workstation_id: hooks.workstationId ?? null,
              platform: process.platform,
            }) + '\n');
            break;
          case 'reload_origins':
            await hooks.onReloadOrigins?.();
            sock.write(JSON.stringify({ ok: true }) + '\n');
            break;
          case 'shutdown':
            sock.write(JSON.stringify({ ok: true }) + '\n');
            setTimeout(() => process.exit(0), 200);
            break;
          default:
            sock.write(JSON.stringify({ ok: false, error: `unknown_op:${op}` }) + '\n');
        }
      } catch (err) {
        sock.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n');
      }
      sock.end();
    });
    sock.on('error', () => { /* client disconnects are normal */ });
  });

  server.on('error', (err) => {
    logger.error('supervisor_error', { error: err instanceof Error ? err.message : String(err) });
  });

  server.listen(SOCK_PATH, () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(SOCK_PATH, 0o600); } catch { /* ignore */ }
    }
    logger.info('supervisor_listening', { path: SOCK_PATH });
  });

  return () => {
    try { server.close(); } catch { /* ignore */ }
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(SOCK_PATH); } catch { /* ignore */ }
    }
  };
}

export const SUPERVISOR_SOCK_PATH = SOCK_PATH;
export const SUPERVISOR_TOKEN_PATH = TOKEN_PATH;