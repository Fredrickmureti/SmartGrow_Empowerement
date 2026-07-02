/**
 * Transport Layer — Exports and transport resolution.
 *
 * `resolveTransport()` is the SINGLE place where the runtime decides
 * which transport to use. All `isPrivateIP` logic lives here.
 * No driver, service, or UI component should duplicate this logic.
 */

export type { ITransport, TransportResult, NetworkTarget, USBTarget } from './TransportAdapter';
export { LocalAgentNetworkTransport, LocalAgentUSBTransport } from './LocalAgentTransport';
export { WebUSBTransport } from './WebUSBTransport';

import { isElectron } from '@/lib/environment';
import type { ITransport } from './TransportAdapter';
import { LocalAgentNetworkTransport, LocalAgentUSBTransport } from './LocalAgentTransport';
import { WebUSBTransport } from './WebUSBTransport';

// ── Private IP detection (single source of truth) ──

/**
 * Check if an IP address is in a private/local range.
 * Private IPs are unreachable from cloud services but reachable
 * from the local agent or Electron's native TCP.
 */
export function isPrivateIP(ip: string): boolean {
  if (ip === 'localhost' || ip === '127.0.0.1') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;                                    // 10.0.0.0/8
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
  if (parts[0] === 192 && parts[1] === 168) return true;               // 192.168.0.0/16
  return false;
}

// ── Transport resolution ──

export interface ResolveTransportOptions {
  connectionType: 'network' | 'usb' | 'serial' | 'bluetooth';
  /** Network target (required when connectionType === 'network') */
  ipAddress?: string;
  port?: number;
  /** USB target (required when connectionType === 'usb') */
  vendorId?: number;
  productId?: number;
}

/**
 * Resolve the correct transport for a device based on runtime environment
 * and connection configuration.
 *
 * Decision tree:
 *
 * 1. Electron running?
 *    → network: ElectronNetworkTransport
 *    → usb:     ElectronUSBTransport
 *
 * 2. Browser + network + any IP:
 *    → LocalAgentNetworkTransport (agent bridges to the printer)
 *    (Note: both private AND public IPs go through the local agent.
 *     There is no cloud edge function path. If the agent is not running,
 *     the transport will report unavailable.)
 *
 * 3. Browser + USB:
 *    → WebUSBTransport (direct browser USB)
 *    → Falls back to LocalAgentUSBTransport if WebUSB unavailable
 */
export function resolveTransport(opts: ResolveTransportOptions): ITransport | null {
  const { connectionType, ipAddress, port, vendorId, productId } = opts;

  // ── Electron ──
  // Track H4 — the renderer-side `ElectronTransport` shell was deleted; in
  // Electron, hardware IO is owned by the main-process CommandRouter and is
  // invoked through `hardwareClient.exec` rather than this resolver. We
  // return `null` here so the rare caller that still routes through this
  // function in Electron mode falls through cleanly.
  if (isElectron()) {
    return null;
  }

  // ── Browser: Network ──
  if (connectionType === 'network' && ipAddress && port) {
    // All network printing in browser mode goes through the local agent.
    return new LocalAgentNetworkTransport({ ipAddress, port });
  }

  // ── Browser: USB ──
  if (connectionType === 'usb' && vendorId != null && productId != null) {
    const webUsb = new WebUSBTransport({ vendorId, productId });
    if (webUsb.isAvailable()) return webUsb;
    return new LocalAgentUSBTransport({ vendorId, productId });
  }

  return null;
}
