import { createServer } from './server.js';
import { createTlsServer } from './server.js';
import { loadOrGenerateLoopbackTls, loopbackTlsNeedsRotation, rotateLoopbackTls, type LoopbackTls } from './tls.js';
import { getAuthToken } from './auth.js';
import { logger } from './logger.js';
import { startRelay } from './relay.js';
import { startManifestPublisher } from './manifest.js';
import { startOriginsRefresh } from './origins.js';
import { refreshOriginsOnce } from './origins.js';
import { startSupervisor } from './supervisor.js';
import { loadConfig } from './relay.js';
import { handlePrint } from './routes/print.js';
import { handleTest } from './routes/test.js';
import { handleUsbDevices, handleUsbPrint } from './routes/usb.js';
import { handleDiscover } from './routes/discover.js';
import { handleStatus } from './routes/status.js';

const PORT = parseInt(process.env.AGENT_PORT || '8043', 10);
const TLS_PORT = parseInt(process.env.AGENT_TLS_PORT || '8443', 10);
const TLS_DISABLED = process.env.AGENT_TLS_DISABLED === '1' || process.env.AGENT_TLS_DISABLED === 'true';

// Phase 4.2 item 1 — load-or-generate the per-install loopback cert
// before the http listener boots so both listeners share the same
// startPeriodicDiscovery() bookkeeping (createServer is idempotent).
//
// Phase 4.2.7a — `tlsInfo` is mutable: the cert can be re-minted at
// runtime (workstation-secret rotation, or an explicit `rotate_cert`
// supervisor op) and hot-swapped into the live listener via
// `tls.Server#setSecureContext`, so trusted operators never have to
// restart the service to recover a compromised loopback key.
let tlsInfo: LoopbackTls | null = TLS_DISABLED ? null : (() => {
  try { return loadOrGenerateLoopbackTls(); }
  catch (err) {
    logger.error('tls_init_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
})();

const getTls = () => tlsInfo;
const server = createServer(getTls);
const tlsServer = tlsInfo ? createTlsServer(tlsInfo, getTls) : null;

/**
 * Re-mint the loopback certificate and push it into the running TLS
 * listener. Returns the new fingerprint, or null when TLS is disabled or
 * generation failed. Safe to call repeatedly.
 */
function rotateCert(secretRotatedAt: string | null): string | null {
  if (!tlsServer) return null;
  try {
    const next = rotateLoopbackTls(secretRotatedAt);
    tlsServer.setSecureContext({ cert: next.cert, key: next.key });
    tlsInfo = next;
    logger.warn('tls_cert_rotated', {
      fingerprint: next.fingerprintSha256,
      secret_rotated_at: secretRotatedAt,
    });
    return next.fingerprintSha256;
  } catch (err) {
    logger.error('tls_cert_rotate_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}


server.listen(PORT, '127.0.0.1', () => {
  const token = getAuthToken();
  logger.info('edge_started', { port: PORT, tls_port: tlsInfo ? TLS_PORT : null, auth: Boolean(token) });
  console.log(`\n  AccrualFlow Edge — Hardware Runtime v1.4.0-edge.p4.2`);
  console.log(`  Listening on http://127.0.0.1:${PORT} (loopback only, legacy)`);
  if (tlsInfo) {
    console.log(`  Listening on https://127.0.0.1:${TLS_PORT} (loopback TLS)`);
    console.log(`  TLS fingerprint (SHA-256): ${tlsInfo.fingerprintSha256}`);
    console.log(`  TLS cert path: ${tlsInfo.path}`);
  } else {
    console.log(`  TLS: DISABLED (AGENT_TLS_DISABLED=1) — loopback HTTPS unavailable`);
  }
  if (token) {
    console.log(`  Auth token: ${token.substring(0, 8)}…  (full token in ~/.pos-agent-token)`);
  } else {
    console.log(`  Auth: DISABLED (dev mode)`);
  }
  console.log(`  Health:  GET  /health`);
  console.log(`  Support: GET  /support-bundle  (auth required)`);
  console.log(`  Logs:    GET  /logs/stream (SSE, auth required)`);

  // ─────────────────────────────────────────────
  // Phase 2 relay: if a workstation config exists we also drain jobs
  // enqueued by the ERP into public.edge_jobs. The relay path is what
  // makes production https://www.accrualflow.systems work at all — the
  // browser can't reach 127.0.0.1 over plaintext HTTP from an HTTPS
  // origin, but it can insert a row and observe the result via Realtime.
  // ─────────────────────────────────────────────
  const stopRelay = startRelay(async (job) => {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    switch (job.role) {
      case 'print': {
        const r = await handlePrint(payload as any);
        return r.success
          ? { success: true, result: r }
          : { success: false, error: r.error ?? 'print_failed', result: r };
      }
      case 'test': {
        const r = await handleTest(payload as any);
        return r.success
          ? { success: true, result: r }
          : { success: false, error: r.error ?? 'test_failed', result: r };
      }
      case 'usb_print': {
        const r = await handleUsbPrint(payload as any);
        return r.success
          ? { success: true, result: r }
          : { success: false, error: r.error ?? 'usb_print_failed', result: r };
      }
      case 'usb_devices': {
        return { success: true, result: handleUsbDevices() };
      }
      case 'discover': {
        const subnet = typeof payload.subnet === 'string' ? payload.subnet : 'auto';
        const r = await handleDiscover(subnet);
        return { success: true, result: r };
      }
      case 'status': {
        return { success: true, result: handleStatus() };
      }
      default:
        return { success: false, error: `unknown_role:${job.role}` };
    }
  });

  // Phase 3 — publish device capability manifest on start and periodically.
  // Phase 4.2.7 — the same publish carries the live TLS fingerprint up to
  // the ERP, and carries the workstation's `secret_rotated_at` back down.
  // When that stamp moves past the one the cert was minted against, the
  // secret has been rotated (likely because it leaked) and the loopback
  // key that shared its trust boundary is re-minted on the spot.
  const stopManifest = startManifestPublisher({
    getTls: () => ({
      enabled: Boolean(tlsInfo),
      fingerprint_sha256: tlsInfo?.fingerprintSha256 ?? null,
      port: tlsInfo ? TLS_PORT : null,
      generated_at: tlsInfo?.generatedAt ?? null,
    }),
    onSecretRotatedAt: (stamp) => {
      if (loopbackTlsNeedsRotation(tlsInfo?.secretRotatedAt ?? null, stamp)) rotateCert(stamp);
    },
  });

  // Phase 4.2.5 — refresh tenant CORS allowlist from edge-workstation-origins.
  const stopOrigins = startOriginsRefresh();

  // Phase 4.2.6 — supervisor IPC so a platform-native service manager
  // (Windows Service via node-windows, macOS LaunchAgent, Linux systemd
  // --user) can host this runtime and the tray app can talk to it as a
  // client. See `agent/scripts/install-service.cjs`.
  const wsCfg = loadConfig();
  const stopSupervisor = startSupervisor({
    version: 'v1.4.0-edge.p4.2.7',
    tlsEnabled: Boolean(tlsInfo),
    tlsFingerprint: () => tlsInfo?.fingerprintSha256 ?? null,
    tlsPort: tlsInfo ? TLS_PORT : null,
    workstationId: wsCfg?.workstation_id ?? null,
    onReloadOrigins: () => { void refreshOriginsOnce(); },
    onRotateCert: () => rotateCert(tlsInfo?.secretRotatedAt ?? null),
  });


  process.on('SIGINT', () => {
    stopRelay();
    stopManifest();
    stopOrigins();
    stopSupervisor();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopRelay();
    stopManifest();
    stopOrigins();
    stopSupervisor();
    process.exit(0);
  });

  console.log(`  Relay:   ${process.env.ACCRUALFLOW_EDGE_CONFIG || '~/.accrualflow/edge/workstation.json'} (auto-started if present)`);
  console.log(`  Manifest: published on start + every 60s to edge/workstation/manifest`);
  console.log(`  Origins: refreshed every 15m from edge/workstation/origins (cached to ~/.accrualflow/edge/origins.json)`);
  console.log(`  Press Ctrl+C to stop\n`);
});

if (tlsServer) {
  tlsServer.listen(TLS_PORT, '127.0.0.1', () => {
    logger.info('edge_tls_listening', { port: TLS_PORT });
  });
  tlsServer.on('error', (err) => {
    logger.error('edge_tls_error', { error: err instanceof Error ? err.message : String(err) });
  });
}
