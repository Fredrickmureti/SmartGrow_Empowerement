/**
 * useResolvedDeviceForDocument — Phase 6, single-registry edition.
 *
 * Given `document_print_policies.device_assignment_id`, return the
 * concrete `device_assignments` row the print router will dispatch to.
 * There is exactly one lookup key: the assignment id. The legacy
 * `printer_profiles` mirror and its `source_config_id` fan-out are gone.
 * No match → `null`, and the caller surfaces "no device bound" rather
 * than guessing a device by role.
 */
import { useMemo } from "react";
import { useDeviceAssignments, type DeviceAssignment } from "@/hooks/useDeviceAssignments";

export interface ResolvedDeviceForDocument {
  device: DeviceAssignment | null;
  isLoading: boolean;
}

export function useResolvedDeviceForDocument(
  boundId: string | null | undefined,
): ResolvedDeviceForDocument {
  const { assignments, isLoading } = useDeviceAssignments();

  const device = useMemo<DeviceAssignment | null>(() => {
    if (!boundId) return null;
    return assignments.find((a) => a.id === boundId) ?? null;
  }, [boundId, assignments]);

  return { device, isLoading };
}
