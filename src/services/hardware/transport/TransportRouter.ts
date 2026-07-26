/**
 * TransportRouter — Wave 9d Phase 5 Step A (foundation).
 *
 * SINGLE decision function that maps a `device_assignments` row to the
 * transport kind the hardware layer should use when talking to it.
 *
 * Why this exists
 * ---------------
 * The audit found ~15 scattered `isElectronMode()` branches inside
 * `HardwareClient.ts` plus a legacy `resolveTransport()` in
 * `transport/index.ts` keyed off `{connectionType, ipAddress, ...}`
 * rather than the persisted `device_assignments.transport` value. That
 * means two devices with the same physical shape but different admin
 * intent (e.g. one bound via LocalAgent, one via WebUSB) would collide.
 *
 * Phase 5 Step A introduces this pure router. Step B rewrites
 * `HardwareClient` to consult it exactly once per call. Step C deletes
 * the legacy `resolveTransport()` + `LocalAgentTransport` renderer
 * shim (Phase 6 cleanup).
 *
 * Purity contract
 * ---------------
 * `route()` MUST be a pure function of `(assignment, host)`:
 *   - No `window` reads other than through `HostCapabilities`.
 *   - No `supabase` reads.
 *   - No `fetch`, no timers, no side effects.
 *
 * `sniffHost()` is the ONLY function in this module that reads runtime
 * globals. Tests inject a fake `HostCapabilities` so `route()` is
 * deterministic across environments.
 */
import { isElectron, supportsWebUSB } from "@/lib/environment";

/** Persisted transport intent on `device_assignments.transport`. */
export type AssignmentTransport =
  | "electron"
  | "local_agent"
  | "webusb"
  | "webhid"
  | "cups"
  | "winspool"
  | "usb"      // legacy alias — pre-Wave-9d rows still carry this
  | "serial"   // legacy alias — routed to local_agent
  | "network"; // legacy alias — routed to local_agent

/** Kind returned to the caller — what physical transport to open. */
export type TransportKind =
  | "electron_native"   // main-process CommandRouter owns IO
  | "local_agent"       // desktop bridge over ws://127.0.0.1
  | "webusb"            // browser WebUSB direct
  | "webhid"            // browser WebHID direct
  | "unavailable";      // requested transport not usable in this host

export interface HostCapabilities {
  isElectron: boolean;
  hasWebUSB: boolean;
  hasWebHID: boolean;
}

/** Minimal shape from `device_assignments` needed to route. */
export interface RoutableAssignment {
  transport: AssignmentTransport | string | null | undefined;
  enabled?: boolean | null;
}

export interface RouteDecision {
  kind: TransportKind;
  /** The normalised transport that produced this decision. */
  requestedTransport: AssignmentTransport;
  /** Why unavailable (only set when kind === "unavailable"). */
  reason?: string;
}

/** Read runtime globals once. Never call from inside `route()`. */
export function sniffHost(): HostCapabilities {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & {
    hid?: unknown;
  }) : undefined;
  return {
    isElectron: isElectron(),
    hasWebUSB: supportsWebUSB(),
    hasWebHID: Boolean(nav && "hid" in nav),
  };
}

const LEGACY_ALIAS: Record<string, AssignmentTransport> = {
  usb: "local_agent",     // pre-Wave-9d rows with bare "usb" flowed through the agent
  serial: "local_agent",
  network: "local_agent",
};

function normalise(t: RoutableAssignment["transport"]): AssignmentTransport {
  if (!t) return "local_agent";
  const raw = String(t).toLowerCase();
  if (raw in LEGACY_ALIAS) return LEGACY_ALIAS[raw];
  return raw as AssignmentTransport;
}

/**
 * Pure routing decision. Does NOT touch runtime globals — pass the
 * result of `sniffHost()` (or an injected stub in tests).
 */
export function route(
  assignment: RoutableAssignment,
  host: HostCapabilities,
): RouteDecision {
  const requestedTransport = normalise(assignment.transport);

  if (assignment.enabled === false) {
    return { kind: "unavailable", requestedTransport, reason: "assignment disabled" };
  }

  switch (requestedTransport) {
    case "electron":
      return host.isElectron
        ? { kind: "electron_native", requestedTransport }
        : { kind: "unavailable", requestedTransport, reason: "electron host required" };

    case "cups":
    case "winspool":
      // OS spooler paths only work inside the Electron main process.
      return host.isElectron
        ? { kind: "electron_native", requestedTransport }
        : { kind: "unavailable", requestedTransport, reason: "OS spooler requires Electron" };

    case "local_agent":
      // Local agent works from either host — Electron just proxies through it.
      return { kind: "local_agent", requestedTransport };

    case "webusb":
      if (host.isElectron) {
        return { kind: "electron_native", requestedTransport };
      }
      return host.hasWebUSB
        ? { kind: "webusb", requestedTransport }
        : { kind: "unavailable", requestedTransport, reason: "WebUSB not supported" };

    case "webhid":
      if (host.isElectron) {
        return { kind: "electron_native", requestedTransport };
      }
      return host.hasWebHID
        ? { kind: "webhid", requestedTransport }
        : { kind: "unavailable", requestedTransport, reason: "WebHID not supported" };

    default:
      return {
        kind: "unavailable",
        requestedTransport,
        reason: `unknown transport: ${String(assignment.transport)}`,
      };
  }
}

/** Convenience: `sniffHost()` + `route()`. */
export function routeWithRuntimeHost(assignment: RoutableAssignment): RouteDecision {
  return route(assignment, sniffHost());
}
