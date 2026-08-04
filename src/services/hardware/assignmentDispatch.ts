/**
 * assignmentDispatch — execution keyed by the resolved `device_assignments`
 * row, not by hardware role.
 *
 * Before this module the platform resolved a device server-side
 * (`resolve_device`) and then threw the answer away: `execAssignment` fell
 * through to `execAny(role, …)`, which re-picked a device by role from the
 * renderer's in-memory registry. Two registries, two answers, and a print
 * that reported success while nothing left the browser.
 *
 * Here the winning row *is* the execution unit. `TransportRouter` says how
 * to reach it; the row's own `config` says where it lives; the row's own
 * `workstation_id` says which agent owns it. No role lookup happens
 * anywhere on this path.
 */
import type { DeviceRole, DriverResult } from './drivers/DriverInterface';
import { agentClient } from './local-agent/AgentClient';
import { toRawBytes } from './payloadBytes';
import { ESCPOS } from './escpos-commands';
import { WebUSBTransport } from './transport/WebUSBTransport';
import {
  route as routeTransport,
  sniffHost,
  type RoutableAssignment,
  type RouteDecision,
} from './transport/TransportRouter';

/** The subset of a `device_assignments` row execution needs. */
export interface ExecutableAssignment extends RoutableAssignment {
  id?: string | null;
  role: DeviceRole;
  driver?: string | null;
  displayName?: string | null;
  /** `device_assignments.config` — endpoint coordinates live here. */
  config?: Record<string, unknown> | null;
  /** `device_assignments.workstation_id` — which agent owns this device. */
  workstationId?: string | null;
}

export interface NetworkEndpoint {
  ipAddress: string;
  port: number;
}

export interface UsbEndpoint {
  vendorId: number;
  productId: number;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** `tcp:192.168.1.50:9100` / `network:192.168.1.50:9100` device identifiers. */
function parseIdentifier(identifier: string | undefined): NetworkEndpoint | null {
  if (!identifier) return null;
  const match = /^(?:tcp|network):(.+):(\d+)$/.exec(identifier);
  if (!match) return null;
  return { ipAddress: match[1], port: Number(match[2]) };
}

export function networkEndpoint(assignment: ExecutableAssignment): NetworkEndpoint | null {
  const cfg = assignment.config ?? {};
  const parsed = parseIdentifier(str(cfg.device_identifier));
  const ipAddress = str(cfg.ipAddress) ?? str(cfg.host) ?? str(cfg.ip) ?? parsed?.ipAddress;
  if (!ipAddress) return null;
  return { ipAddress, port: num(cfg.port) ?? parsed?.port ?? 9100 };
}

export function usbEndpoint(assignment: ExecutableAssignment): UsbEndpoint | null {
  const cfg = assignment.config ?? {};
  const vendorId = num(cfg.vendorId) ?? num(cfg.vendor_id);
  const productId = num(cfg.productId) ?? num(cfg.product_id);
  if (vendorId == null || productId == null) return null;
  return { vendorId, productId };
}

/** Ops that carry a byte body rather than a control instruction. */
const BYTE_OPS = new Set([
  'print_raw',
  'print_receipt',
  'print_label',
  'print_ticket',
  'print',
]);

const DRAWER_OPS = new Set(['open', 'open_drawer', 'kick']);

/**
 * Reduce `(op, payload)` to the bytes a raw transport should write.
 * Returns an error string when the op cannot be expressed as bytes.
 */
export function bytesForOp(
  op: string,
  payload: unknown,
): { bytes: number[] } | { error: string } {
  if (DRAWER_OPS.has(op)) {
    const pin = (payload as { pin?: 2 | 5 } | undefined)?.pin;
    return { bytes: pin === 5 ? [...ESCPOS.OPEN_DRAWER_PIN5] : [...ESCPOS.OPEN_DRAWER_PIN2] };
  }
  if (!BYTE_OPS.has(op)) {
    return { error: `op '${op}' is not supported on a raw byte transport` };
  }
  const bytes = toRawBytes(payload);
  if (!bytes || bytes.length === 0) {
    return { error: `op '${op}' payload carries no bytes/zpl/epl/text` };
  }
  return { bytes };
}

export interface DispatchToAssignmentInput {
  assignment: ExecutableAssignment;
  op: string;
  payload?: unknown;
  idempotencyKey?: string;
  /** Electron IPC executor, injected by `HardwareClient` to avoid a cycle. */
  execElectron: (role: DeviceRole, op: string, payload: unknown) => Promise<DriverResult>;
  /** True when the main-process bridge is actually reachable. */
  ipcAvailable: boolean;
}

/**
 * Execute one op against one resolved assignment. The returned
 * `DriverResult` is honest: a transport that refused, timed out, or was
 * never reachable comes back `success: false` with the reason.
 */
export async function dispatchToAssignment(
  input: DispatchToAssignmentInput,
): Promise<DriverResult & { decision: RouteDecision }> {
  const { assignment, op, payload } = input;
  const decision = routeTransport(assignment, sniffHost());

  const fail = (error: string): DriverResult & { decision: RouteDecision } => ({
    success: false,
    error,
    decision,
  });

  if (decision.kind === 'unavailable') {
    return fail(`Transport unavailable: ${decision.reason ?? decision.requestedTransport}`);
  }

  if (decision.kind === 'electron_native') {
    if (!input.ipcAvailable) {
      return fail(
        'This device is bound to the desktop app, but the desktop hardware bridge is not available in this session.',
      );
    }
    const res = await input.execElectron(assignment.role, op, payload);
    return { ...res, decision };
  }

  const encoded = bytesForOp(op, payload);
  if ('error' in encoded) return fail(encoded.error);

  if (decision.kind === 'local_agent') {
    const net = networkEndpoint(assignment);
    if (net) {
      const res = await agentClient.printNetwork(net.ipAddress, net.port, encoded.bytes, {
        workstationId: assignment.workstationId ?? null,
      });
      return {
        success: Boolean(res.success),
        error: res.success ? undefined : (res.error ?? 'agent did not accept the job'),
        decision,
      };
    }
    const usb = usbEndpoint(assignment);
    if (usb) {
      const res = await agentClient.printUsb(usb.vendorId, usb.productId, encoded.bytes, {
        workstationId: assignment.workstationId ?? null,
      });
      return {
        success: Boolean(res.success),
        error: res.success ? undefined : (res.error ?? 'agent did not accept the job'),
        decision,
      };
    }
    return fail(
      `${assignment.displayName ?? assignment.role} has no endpoint configured — set an IP address/port or USB vendor/product in Hardware settings.`,
    );
  }

  if (decision.kind === 'webusb') {
    const usb = usbEndpoint(assignment);
    if (!usb) return fail(`${assignment.displayName ?? assignment.role} has no USB vendor/product configured.`);
    const transport = new WebUSBTransport({ vendorId: usb.vendorId, productId: usb.productId });
    const res = await transport.write(new Uint8Array(encoded.bytes));
    return {
      success: Boolean(res.success),
      error: res.success ? undefined : (res.error ?? 'WebUSB write failed'),
      decision,
    };
  }

  return fail(`No renderer transport implements '${decision.kind}'.`);
}