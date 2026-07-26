/**
 * useResolvedDeviceForDocument — Phase 2b, unified registry edition.
 *
 * Given the id stored on `document_print_policies` (either the new
 * `device_assignment_id` or the legacy `printer_profile_id` before the
 * mirror was collapsed), this hook returns the concrete
 * `device_assignments` row the print router will dispatch to.
 *
 * Resolution order:
 *   1. Exact match on `device_assignments.id`.
 *   2. Match on `source_config_id` (the retained legacy printer_profiles
 *      key). Both cases collapse to the same physical device now that
 *      Phase 2a mirrored every printer_profile into an assignment.
 *   3. Null — caller falls back to role-based selection.
 */
import { useMemo } from "react";
import { useDeviceAssignments, type DeviceAssignment } from "@/hooks/useDeviceAssignments";
import { usePrinterProfiles, type PrinterProfile } from "@/hooks/usePrinterProfiles";

export interface ResolvedDeviceForDocument {
  device: DeviceAssignment | null;
  profile: PrinterProfile | null;
  isLoading: boolean;
}

export function useResolvedDeviceForDocument(
  businessId: string | null | undefined,
  boundId: string | null | undefined,
): ResolvedDeviceForDocument {
  const { loading: profilesLoading, findById } = usePrinterProfiles(businessId);
  const { assignments, isLoading: assignmentsLoading } = useDeviceAssignments();

  const profile = useMemo(() => findById(boundId), [findById, boundId]);

  const device = useMemo<DeviceAssignment | null>(() => {
    if (!boundId) return null;
    // The bound id may be either a device_assignments.id or a legacy
    // printer_profiles.id (kept alive as `source_config_id`). Try both.
    const direct = assignments.find((a) => a.id === boundId);
    if (direct) return direct;
    const viaLegacy = assignments.find((a) => a.source_config_id === boundId);
    return viaLegacy ?? null;
  }, [boundId, assignments]);

  return {
    device,
    profile: profile ?? null,
    isLoading: profilesLoading || assignmentsLoading,
  };
}
