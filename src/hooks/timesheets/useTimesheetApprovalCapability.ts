/**
 * useTimesheetApprovalCapabilities — server-authoritative approval capability.
 *
 * The client NEVER decides whether a submission may be approved. The
 * `timesheet_approval_capability` RPC combines lifecycle state, approval
 * competence and the Governance self-action verdict (organisation governance
 * mode, self-action policy, and time-limited approved exceptions) and returns
 * the single authoritative answer. This hook only projects that answer.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface TimesheetApprovalCapability {
  canApprove: boolean;
  requiresOverride: boolean;
  reason: string;
}

export type TimesheetApprovalCapabilityMap = Record<string, TimesheetApprovalCapability>;

export function useTimesheetApprovalCapabilities(submissionIds: string[]) {
  const [capabilities, setCapabilities] = useState<TimesheetApprovalCapabilityMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const key = submissionIds.join(",");

  const fetchCapabilities = useCallback(async () => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setCapabilities({});
      return;
    }
    setIsLoading(true);
    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          const { data, error } = await supabase.rpc("timesheet_approval_capability" as any, {
            _submission_id: id,
          });
          if (error) throw error;
          const row = (Array.isArray(data) ? data[0] : data) as
            | { can_approve: boolean; requires_override: boolean; reason: string }
            | undefined;
          return [
            id,
            {
              canApprove: !!row?.can_approve,
              requiresOverride: !!row?.requires_override,
              reason: row?.reason ?? "unknown",
            },
          ] as const;
        }),
      );
      setCapabilities(Object.fromEntries(results));
    } catch (error) {
      console.error("Error loading timesheet approval capability:", error);
      // Fail closed: without an authoritative answer, nothing is approvable.
      setCapabilities({});
    } finally {
      setIsLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void fetchCapabilities();
  }, [fetchCapabilities]);

  return { capabilities, isLoading, refresh: fetchCapabilities };
}
