import { createServer } from './server.js';
import { createTlsServer } from './server.js';
import { loadOrGenerateLoopbackTls } from './tls.js';
import { getAuthToken } from './auth.js';
import { logger } from './logger.js';
import { startRelay } from './relay.js';
import { startManifestPublisher } from './manifest.js';
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
const tlsInfo = TLS_DISABLED ? null : (() => {
  try { return loadOrGenerateLoopbackTls(); }
  catch (err) {
    logger.error('tls_init_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
})();

const server = createServer(tlsInfo);
const tlsServer = tlsInfo ? createTlsServer(tlsInfo) : null;

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
  const stopManifest = startManifestPublisher();

  process.on('SIGINT', () => {
    stopRelay();
    stopManifest();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopRelay();
    stopManifest();
    process.exit(0);
  });

  console.log(`  Relay:   ${process.env.ACCRUALFLOW_EDGE_CONFIG || '~/.accrualflow/edge/workstation.json'} (auto-started if present)`);
  console.log(`  Manifest: published on start + every 60s to edge-workstation-manifest`);
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
