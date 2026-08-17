/**
 * useCountGovernancePreview — asks the ONE governance engine what it will
 * decide for this count's differences, instead of the screen guessing.
 *
 * Warehouse used to tell the operator "a manager must approve this in
 * Inventory" no matter what, which is false in SOLO mode (and false in any
 * tenant that never wrote an approval rule for cycle counts). The server
 * routes `warehouse.count_variance` through `approval_route`; this read-only
 * preview reports the same routing outcome so the copy matches reality.
 *
 * Read-only: it never creates an approval request.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CountGovernancePreview {
  found: boolean;
  governance_mode: string | null;
  action_key: string;
  variance_lines: number;
  variance_units: number;
  variance_value: number;
  lines_outside_tolerance: number;
  gated: boolean;
  rule_id: string | null;
  rule_description: string | null;
  approver_type: string | null;
  approver_role: string | null;
  approval_request_id: string | null;
  approval_status: string | null;
}

export function useCountGovernancePreview(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["wms-count-governance-preview", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "wms_count_governance_preview" as never,
        { p_session_id: sessionId! } as never,
      );
      if (error) throw error;
      return data as unknown as CountGovernancePreview;
    },
  });
}

/** Plain-language sentence for the review screen. Server truth, no guessing. */
export function describeCountGovernance(
  p: CountGovernancePreview | undefined,
  pendingLines: number,
): string | null {
  if (!p?.found || pendingLines <= 0) return null;
  const n = `${pendingLines} line${pendingLines === 1 ? "" : "s"}`;
  if (p.approval_request_id) {
    return `${n} exceed the allowed difference and are waiting on approval request ${p.approval_request_id.slice(0, 8)} (${p.approval_status ?? "pending"}). Stock moves once that decision is made.`;
  }
  if (p.gated) {
    const who = p.approver_role
      ? `the ${p.approver_role.replace(/_/g, " ")} role`
      : "an approver";
    return `${n} exceed the allowed difference. Your approval policy sends this to ${who} before stock moves.`;
  }
  return `${n} exceed the allowed difference. No approval policy applies${
    p.governance_mode ? ` in ${p.governance_mode.toLowerCase()} mode` : ""
  }, so submitting records the difference and moves stock straight away.`;
}
