/**
 * AccrualFlow Edge — Phase 3 capability manifest publisher.
 *
 * Builds a normalized manifest of every hardware device we can currently
 * observe on this workstation and POSTs it to `edge-workstation-manifest`.
 *
 * We publish:
 *   - on agent start (once the relay config is loaded), and
 *   - every MANIFEST_INTERVAL_MS thereafter (so device offline / online
 *     transitions surface without waiting for the next agent restart).
 *
 * The manifest lets the ERP dispatch by capability
 *   { role: 'receipt_printer', needs: { width_mm: 80, cutter: true } }
 * instead of by hard-coded (ip, port) or (vid, pid). See ADR-0084 / plan.md
 * §3 for the design rationale.
 */

import { logger } from './logger.js';
import { AGENT_VERSION, loadConfig, type RelayConfig } from './relay.js';
import { handleDiscover } from './routes/discover.js';
import { handleTest } from './routes/test.js';

const MANIFEST_INTERVAL_MS = 60_000;

export type DeviceRole =
  | 'receipt_printer' | 'label_printer' | 'scanner' | 'drawer' | 'scale'
  | 'display' | 'eft_terminal' | 'biometric' | 'signature_pad'
  | 'rfid_reader' | 'camera' | 'other';

export type DeviceTransport =
  | 'usb' | 'tcp' | 'serial' | 'bluetooth' | 'hid' | 'virtual' | 'other';

export type DeviceHealth = 'ok' | 'degraded' | 'offline' | 'error' | 'unknown';

export interface ManifestDevice {
  device_key: string;
  role: DeviceRole;
  transport: DeviceTransport;
  driver?: string | null;
  name?: string | null;
  capabilities: Record<string, unknown>;
  health: DeviceHealth;
  metadata?: Record<string, unknown>;
}

/**
 * Vendor/product hints we already trust — kept intentionally small; drivers
 * from Phase 5 will contribute richer capability data via a probe() call.
 */
const USB_HINTS: Record<string, { name: string; role: DeviceRole; driver: string; capabilities: Record<string, unknown> }> = {
  '04b8': { name: 'Epson', role: 'receipt_printer', driver: 'escpos', capabilities: { width_mm: 80, cutter: true, cash_drawer_kick: true } },
  '0519': { name: 'Star Micronics', role: 'receipt_printer', driver: 'escpos', capabilities: { width_mm: 80, cutter: true } },
  '0a5f': { name: 'Zebra', role: 'label_printer', driver: 'zpl', capabilities: { width_mm: 104 } },
  '154f': { name: 'Bixolon', role: 'receipt_printer', driver: 'escpos', capabilities: { width_mm: 80, cutter: true } },
};

async function collectDevices(): Promise<ManifestDevice[]> {
  const out: ManifestDevice[] = [];

  // 1) USB — best-effort, module optional.
  try {
    const usbMod = await import('usb');
    for (const dev of usbMod.getDeviceList()) {
      const vid = dev.deviceDescriptor.idVendor;
      const pid = dev.deviceDescriptor.idProduct;
      const vidHex = vid.toString(16).padStart(4, '0');
      const pidHex = pid.toString(16).padStart(4, '0');
      const hint = USB_HINTS[vidHex];
      if (!hint) continue; // ignore keyboards, hubs, etc.
      out.push({
        device_key: `usb:${vidHex}:${pidHex}`,
        role: hint.role,
        transport: 'usb',
        driver: hint.driver,
        name: hint.name,
        capabilities: hint.capabilities,
        health: 'ok',
        metadata: { vendor_id: vid, product_id: pid },
      });
    }
  } catch {
    /* usb module not installed on this workstation — skip */
  }

  // 2) Network — reuse the existing discover routine (port 9100 raw TCP).
  try {
    // Local simulators / local USB-to-TCP bridges commonly bind only
    // 127.0.0.1:9100, which a LAN subnet scan will never see.
    const local = await handleTest({ ipAddress: '127.0.0.1', port: 9100, timeout: 300 });
    if (local.success) {
      out.push({
        device_key: 'tcp:127.0.0.1:9100',
        role: 'label_printer',
        transport: 'tcp',
        driver: 'zpl',
        name: 'Local ZPL printer',
        capabilities: { language: 'zpl', width_mm: 104, port: 9100 },
        health: 'ok',
        metadata: { identifier: '127.0.0.1:9100', ipAddress: '127.0.0.1', port: 9100 },
      });
    }

    const net = await handleDiscover('auto');
    for (const d of net.devices) {
      if (!d.ipAddress) continue;
      if (d.ipAddress === '127.0.0.1') continue;
      out.push({
        device_key: `tcp:${d.ipAddress}:${d.port ?? 9100}`,
        role: 'receipt_printer',
        transport: 'tcp',
        driver: 'escpos',
        name: d.name ?? d.identifier,
        capabilities: { width_mm: 80, port: d.port ?? 9100 },
        health: 'ok',
        metadata: { identifier: d.identifier, ipAddress: d.ipAddress, port: d.port ?? 9100 },
      });
    }
  } catch (err) {
    logger.warn('manifest.discover_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  return out;
}

/**
 * Phase 4.2.7b — the manifest is also how the loopback TLS identity
 * reaches the ERP. Publishing the fingerprint here (rather than adding
 * another endpoint) means the value the browser pins is always the value
 * the running agent is actually presenting: they are written by the same
 * process, in the same request, on the same 60 s cadence.
 */
export interface ManifestTlsInfo {
  enabled: boolean;
  fingerprint_sha256: string | null;
  port: number | null;
  generated_at: string | null;
}

export interface ManifestPublisherHooks {
  /** Read lazily so a mid-flight cert rotation is published immediately. */
  getTls?: () => ManifestTlsInfo;
  /**
   * Invoked with the server's `secret_rotated_at` on every successful
   * publish. The runtime compares it against the stamp recorded in the
   * cert metadata and re-mints when the secret has moved on.
   */
  onSecretRotatedAt?: (stamp: string | null) => Promise<void> | void;
}

async function publishOnce(cfg: RelayConfig, hooks: ManifestPublisherHooks): Promise<void> {
  const devices = await collectDevices();
  const tls = hooks.getTls?.();
  const res = await fetch(`${cfg.supabase_url}/functions/v1/edge/workstation/manifest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.workstation_secret}`,
      'X-Workstation-Id': cfg.workstation_id,
    },
    body: JSON.stringify({ agent_version: AGENT_VERSION, devices, tls }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`manifest_http_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => null) as { secret_rotated_at?: string | null } | null;
  await hooks.onSecretRotatedAt?.(json?.secret_rotated_at ?? null);
  logger.info('manifest.published', { count: devices.length, tls: Boolean(tls?.enabled) });
}

/**
 * Start periodic manifest publishing. No-op if the relay isn't configured —
 * without a workstation identity there's nowhere to publish to.
 */
export function startManifestPublisher(hooks: ManifestPublisherHooks = {}): () => void {
  const cfg = loadConfig();
  if (!cfg) {
    logger.info('manifest.inactive.no_config', {});
    return () => undefined;
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await publishOnce(cfg, hooks); }
    catch (err) { logger.warn('manifest.publish_failed', { error: err instanceof Error ? err.message : String(err) }); }
    if (!stopped) setTimeout(tick, MANIFEST_INTERVAL_MS);
  };
  // Slight startup delay so background discovery has a chance to warm up.
  setTimeout(tick, 5_000);
  return () => { stopped = true; };
}

