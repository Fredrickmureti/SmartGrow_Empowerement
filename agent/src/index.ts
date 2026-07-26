import { createServer } from './server.js';
import { getAuthToken } from './auth.js';
import { logger } from './logger.js';
import { startRelay } from './relay.js';
import { handlePrint } from './routes/print.js';
import { handleTest } from './routes/test.js';
import { handleUsbDevices, handleUsbPrint } from './routes/usb.js';
import { handleDiscover } from './routes/discover.js';
import { handleStatus } from './routes/status.js';

const PORT = parseInt(process.env.AGENT_PORT || '8043', 10);

const server = createServer();

server.listen(PORT, '127.0.0.1', () => {
  const token = getAuthToken();
  logger.info('edge_started', { port: PORT, auth: Boolean(token) });
  console.log(`\n  AccrualFlow Edge — Hardware Runtime v1.2.0-edge.p2`);
  console.log(`  Listening on http://127.0.0.1:${PORT} (loopback only)`);
  if (token) {
    console.log(`  Auth token: ${token.substring(0, 8)}…  (full token in ~/.pos-agent-token)`);
  } else {
    console.log(`  Auth: DISABLED (dev mode)`);
  }
  console.log(`  Health:  GET  /health`);
  console.log(`  Support: GET  /support-bundle  (auth required)`);

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

  process.on('SIGINT', () => {
    stopRelay();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopRelay();
    process.exit(0);
  });

  console.log(`  Relay:   ${process.env.ACCRUALFLOW_EDGE_CONFIG || '~/.accrualflow/edge/workstation.json'} (auto-started if present)`);
  console.log(`  Press Ctrl+C to stop\n`);
});
