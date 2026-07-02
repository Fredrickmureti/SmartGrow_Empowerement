/**
 * useResolvedDeviceForDocument — Wave 9d.9 (P3 #17).
 *
 * The audit found that `document_print_policies.printer_profile_id`
 * resolves to a `printer_profiles` row (paper format + transport +
 * address) but never to an actual `device_assignments` row. Callers
 * then had to guess which receipt/label printer to dispatch to — a
 * source of cross-business and cross-branch mis-routing.
 *
 * This hook closes the gap: given a `printer_profile_id` (from the
 * resolved policy) it returns the best-matching enabled
 * `device_assignments` row by matching transport + address heuristically.
 *
 * Match precedence:
 *   1. Same transport AND address matches (host:port, OS printer name,
 *      agent printer id, or "vid:pid").
 *   2. Same transport, no explicit address → first enabled row.
 *   3. Null → caller falls back to role-based selection.
 */
import { useMemo } from "react";
import { useDeviceAssignments, type DeviceAssignment } from "@/hooks/useDeviceAssignments";
import { usePrinterProfiles, type PrinterProfile } from "@/hooks/usePrinterProfiles";

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function addressMatches(profile: PrinterProfile, a: DeviceAssignment): boolean {
  const addr = normalize(profile.address);
  if (!addr) return true; // profile has no specific address → match by transport only
  const cfg = (a.config ?? {}) as Record<string, unknown>;

  // network: "host:port"
  const host = normalize(cfg.host as string | undefined);
  const port = cfg.port ? String(cfg.port) : "";
  if (host && (addr === `${host}:${port}` || addr === host)) return true;

  // electron / agent: OS printer name or agent id (e.g. "usb:Star_TSP100")
  const name = normalize((cfg.name as string | undefined) ?? (cfg.printerId as string | undefined));
  if (name && addr === name) return true;

  // web_usb: "vid:pid" (hex)
  const vid = cfg.vendorId as number | undefined;
  const pid = cfg.productId as number | undefined;
  if (typeof vid === "number" && typeof pid === "number") {
    const tag = `${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;
    if (addr.includes(tag)) return true;
  }

  return false;
}

const TRANSPORT_ALIASES: Record<string, string[]> = {
  electron: ["cups", "winspool"],
  local_agent: ["usb", "network", "serial"],
  web_usb: ["usb"],
  network: ["network"],
  browser: [],
};

export interface ResolvedDeviceForDocument {
  device: DeviceAssignment | null;
  profile: PrinterProfile | null;
  isLoading: boolean;
}

export function useResolvedDeviceForDocument(
  businessId: string | null | undefined,
  printerProfileId: string | null | undefined,
): ResolvedDeviceForDocument {
  const { loading: profilesLoading, findById } = usePrinterProfiles(businessId);
  const { assignments, isLoading: assignmentsLoading } = useDeviceAssignments();

  const profile = useMemo(() => findById(printerProfileId), [findById, printerProfileId]);

  const device = useMemo<DeviceAssignment | null>(() => {
    if (!profile) return null;
    const allowed = new Set<string>([profile.transport, ...(TRANSPORT_ALIASES[profile.transport] ?? [])]);
    const enabled = assignments.filter((a) => a.enabled);
    // Layer 1 — transport + address match.
    const exact = enabled.find((a) => allowed.has(a.transport) && addressMatches(profile, a));
    if (exact) return exact;
    // Layer 2 — transport-only fallback among receipt-like roles.
    const sameTransport = enabled.find((a) => allowed.has(a.transport));
    return sameTransport ?? null;
  }, [profile, assignments]);

  return {
    device,
    profile: profile ?? null,
    isLoading: profilesLoading || assignmentsLoading,
  };
}
