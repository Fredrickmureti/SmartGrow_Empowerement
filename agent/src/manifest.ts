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
    const net = await handleDiscover('auto');
    for (const d of net.devices) {
      if (!d.ipAddress) continue;
      out.push({
        device_key: `tcp:${d.ipAddress}:${d.port ?? 9100}`,
        role: 'receipt_printer',
        transport: 'tcp',
        driver: 'escpos',
        name: d.name ?? d.identifier,
        capabilities: { width_mm: 80, port: d.port ?? 9100 },
        health: 'ok',
        metadata: { identifier: d.identifier },
      });
    }
  } catch (err) {
    logger.warn('manifest.discover_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  return out;
}

async function publishOnce(cfg: RelayConfig): Promise<void> {
  const devices = await collectDevices();
  const res = await fetch(`${cfg.supabase_url}/functions/v1/edge-workstation-manifest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.workstation_secret}`,
      'X-Workstation-Id': cfg.workstation_id,
    },
    body: JSON.stringify({ agent_version: AGENT_VERSION, devices }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`manifest_http_${res.status}: ${body.slice(0, 200)}`);
  }
  logger.info('manifest.published', { count: devices.length });
}

/**
 * Start periodic manifest publishing. No-op if the relay isn't configured —
 * without a workstation identity there's nowhere to publish to.
 */
export function startManifestPublisher(): () => void {
  const cfg = loadConfig();
  if (!cfg) {
    logger.info('manifest.inactive.no_config', {});
    return () => undefined;
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await publishOnce(cfg); }
    catch (err) { logger.warn('manifest.publish_failed', { error: err instanceof Error ? err.message : String(err) }); }
    if (!stopped) setTimeout(tick, MANIFEST_INTERVAL_MS);
  };
  // Slight startup delay so background discovery has a chance to warm up.
  setTimeout(tick, 5_000);
  return () => { stopped = true; };
}
