/**
 * Transport Layer — Exports and transport instantiation.
 *
 * Wave 9d Phase 5 Step C: the transport *decision* is owned exclusively by
 * `TransportRouter.route()`, which is a pure function of the persisted
 * `device_assignments.transport` value plus host capabilities. This module
 * no longer decides anything from `connectionType`/IP shape — it only turns
 * a `RouteDecision` into a concrete `ITransport` instance.
 */

export type { ITransport, TransportResult, NetworkTarget, USBTarget } from './TransportAdapter';
export { LocalAgentNetworkTransport, LocalAgentUSBTransport } from './LocalAgentTransport';
export { WebUSBTransport } from './WebUSBTransport';

import type { ITransport } from './TransportAdapter';
import { LocalAgentNetworkTransport, LocalAgentUSBTransport } from './LocalAgentTransport';
import { WebUSBTransport } from './WebUSBTransport';
import { routeWithRuntimeHost, type AssignmentTransport } from './TransportRouter';

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

// ── Transport instantiation ──

export interface ResolveTransportOptions {
  /**
   * The persisted `device_assignments.transport` intent. Legacy aliases
   * (`network`, `usb`, `serial`) are normalised by `TransportRouter`.
   */
  transport: AssignmentTransport | string | null | undefined;
  /** `false` disables the assignment — the router returns `unavailable`. */
  enabled?: boolean | null;
  /** Network target (required when connectionType === 'network') */
  ipAddress?: string;
  port?: number;
  /** USB target (required when connectionType === 'usb') */
  vendorId?: number;
  productId?: number;
}

/**
 * Instantiate the transport for an assignment.
 *
 * The decision itself comes from `TransportRouter.route()`. `null` means the
 * renderer must not deliver bytes for this assignment — either the Electron
 * main-process CommandRouter owns the IO (`electron_native`) or the requested
 * transport is unusable in this host (`unavailable`). Callers surface that as
 * an explicit error; there is no silent fallback to another transport.
 */
export function resolveTransport(opts: ResolveTransportOptions): ITransport | null {
  const { ipAddress, port, vendorId, productId } = opts;
  const decision = routeWithRuntimeHost({ transport: opts.transport, enabled: opts.enabled });

  switch (decision.kind) {
    case 'local_agent':
      if (ipAddress && port) return new LocalAgentNetworkTransport({ ipAddress, port });
      if (vendorId != null && productId != null) {
        return new LocalAgentUSBTransport({ vendorId, productId });
      }
      return null;

    case 'webusb':
      if (vendorId == null || productId == null) return null;
      return new WebUSBTransport({ vendorId, productId });

    // `electron_native` → main-process CommandRouter owns IO.
    // `webhid` → no renderer transport implementation.
    // `unavailable` → explicit failure, never a fallback.
    default:
      return null;
  }
}
