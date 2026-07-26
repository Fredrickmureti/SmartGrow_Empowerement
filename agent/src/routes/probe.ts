/**
 * POST /probe — authenticated device self-test dispatcher.
 *
 * Phase 4.2 item 4. Diagnostics UI in the desktop shell calls this to
 * run a well-defined probe against a device the operator can see in the
 * Devices tab. Each probe maps to an existing handler under this
 * directory; we deliberately don't spawn any new transport code here —
 * probes are just curated, idempotency-keyed wrappers.
 *
 * Supported (role, op) pairs:
 *   receipt_printer  / printer.test_page   — ESC/POS test slip
 *   label_printer    / printer.test_page   — ESC/POS test slip (safe fallback for any thermal)
 *   cash_drawer      / drawer.kick         — ESC/POS drawer kick pulse via bonded receipt printer
 *   any              / network.ping        — TCP connect to ipAddress:port
 *   any              / usb.list            — enumerate USB devices seen by the runtime
 *
 * Rate limiting: a 5s cooldown per `(deviceId, op)` idempotency key.
 * A repeat inside the window returns 429 and the cached previous result.
 * That gives the UI a safe click-happy affordance without hammering
 * transports whose "test page" costs a strip of paper.
 */

import { handlePrint } from './print.js';
import { handleTest } from './test.js';
import { handleUsbPrint, handleUsbDevices } from './usb.js';
import { logger } from '../logger.js';

export type ProbeOp =
  | 'printer.test_page'
  | 'drawer.kick'
  | 'network.ping'
  | 'usb.list';

export interface ProbeTarget {
  transport?: 'network' | 'usb';
  driver?: string;
  ipAddress?: string;
  port?: number;
  vendorId?: number;
  productId?: number;
}

export interface ProbeRequest {
  /** Stable identifier the UI already knows (workstation_devices.id). */
  deviceId?: string;
  role?: string;
  op: ProbeOp;
  target?: ProbeTarget;
}

export interface ProbeResult {
  success: boolean;
  op: ProbeOp;
  deviceId?: string;
  detail?: string;
  error?: string;
  bytesWritten?: number;
  responseTimeMs?: number;
  data?: unknown;
  cached?: boolean;
  cooldownMs?: number;
}

// ─── ESC/POS byte builders ────────────────────────────────────────────
//
// Deliberately minimal: initialise, print a short header, feed, cut.
// This is enough to prove the transport works end-to-end without
// leaning on the app's full print pipeline.

const ESC = 0x1b;
const GS = 0x1d;

function buildTestPageBytes(): number[] {
  const bytes: number[] = [];
  bytes.push(ESC, 0x40); // init
  bytes.push(ESC, 0x61, 0x01); // center align
  bytes.push(...str('AccrualFlow Edge\n'));
  bytes.push(...str('Diagnostic test slip\n'));
  bytes.push(ESC, 0x61, 0x00); // left align
  bytes.push(0x0a);
  bytes.push(...str(`Time: ${new Date().toISOString()}\n`));
  bytes.push(...str('If you can read this, the transport is working.\n'));
  bytes.push(0x0a, 0x0a, 0x0a);
  bytes.push(GS, 0x56, 0x00); // full cut
  return bytes;
}

function buildZplTestPageBytes(): number[] {
  return str(
    '^XA\n' +
    '^PW812\n' +
    '^LL406\n' +
    '^FO40,40^A0N,36,36^FDAccrualFlow Edge^FS\n' +
    '^FO40,90^A0N,28,28^FDZPL diagnostic label^FS\n' +
    `^FO40,140^A0N,22,22^FD${new Date().toISOString()}^FS\n` +
    '^FO40,190^GB720,3,3^FS\n' +
    '^FO40,230^A0N,24,24^FDTransport working^FS\n' +
    '^XZ\n',
  );
}

/** ESC p 0 <t1> <t2> — pin 2 drawer kick (~50ms). */
function buildDrawerKickBytes(): number[] {
  return [ESC, 0x70, 0x00, 0x19, 0xfa];
}

function str(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  return out;
}

// ─── Rate-limit cache ─────────────────────────────────────────────────

interface CacheEntry { at: number; result: ProbeResult }
const COOLDOWN_MS = 5_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(req: ProbeRequest): string {
  return `${req.deviceId ?? '_'}::${req.op}`;
}

// ─── Dispatcher ───────────────────────────────────────────────────────

export async function handleProbe(req: ProbeRequest): Promise<{ status: number; body: ProbeResult }> {
  if (!req || typeof req !== 'object' || typeof req.op !== 'string') {
    return { status: 400, body: { success: false, op: 'network.ping', error: 'Missing op' } };
  }

  const key = cacheKey(req);
  const prev = cache.get(key);
  if (prev && Date.now() - prev.at < COOLDOWN_MS) {
    return {
      status: 429,
      body: { ...prev.result, cached: true, cooldownMs: COOLDOWN_MS - (Date.now() - prev.at) },
    };
  }

  const result = await dispatch(req);
  cache.set(key, { at: Date.now(), result });
  logger.info('probe', { deviceId: req.deviceId, role: req.role, op: req.op, success: result.success });
  return { status: result.success ? 200 : 502, body: result };
}

async function dispatch(req: ProbeRequest): Promise<ProbeResult> {
  const base: Pick<ProbeResult, 'op' | 'deviceId'> = { op: req.op, deviceId: req.deviceId };

  switch (req.op) {
    case 'network.ping': {
      const t = req.target ?? {};
      if (!t.ipAddress || !t.port) {
        return { ...base, success: false, error: 'target.ipAddress and target.port are required' };
      }
      const r = await handleTest({ ipAddress: t.ipAddress, port: t.port, timeout: 3000 });
      return { ...base, success: r.success, error: r.error, responseTimeMs: r.responseTimeMs };
    }

    case 'usb.list': {
      const list = handleUsbDevices();
      return { ...base, success: true, data: list };
    }

    case 'printer.test_page':
    case 'drawer.kick': {
      const t = req.target ?? {};
      const isZpl = req.role === 'label_printer' || t.driver === 'zpl';
      const bytes = req.op === 'drawer.kick'
        ? buildDrawerKickBytes()
        : isZpl
          ? buildZplTestPageBytes()
          : buildTestPageBytes();
      const transport = t.transport
        ?? (t.ipAddress ? 'network' : t.vendorId != null ? 'usb' : undefined);

      if (transport === 'network') {
        if (!t.ipAddress || !t.port) {
          return { ...base, success: false, error: 'target.ipAddress and target.port are required for network transport' };
        }
        const r = await handlePrint({ ipAddress: t.ipAddress, port: t.port, data: bytes });
        return { ...base, success: r.success, error: r.error, bytesWritten: r.bytesWritten };
      }
      if (transport === 'usb') {
        if (t.vendorId == null || t.productId == null) {
          return { ...base, success: false, error: 'target.vendorId and target.productId are required for USB transport' };
        }
        const r = await handleUsbPrint({ vendorId: t.vendorId, productId: t.productId, data: bytes });
        return { ...base, success: r.success, error: r.error };
      }
      return { ...base, success: false, error: 'target.transport must be "network" or "usb"' };
    }

    default:
      return { ...base, success: false, error: `Unknown op: ${(req as { op: string }).op}` };
  }
}