/**
 * useGovernanceMode — reads the org-wide governance stance from
 * `organizations.governance_mode`. This is the same setting shown in
 * Settings › Governance › Governance mode card.
 *
 * Modes:
 *   solo     → single-operator tenant; the platform lets a user auto-approve
 *              their own workflows (recommendations, POs, etc.). Segregation
 *              of duties is not enforced in the UI.
 *   standard → warn / policy-driven. Same-user approval is gated by the
 *              per-action `self_action_policy` row (see useSelfActionPolicy).
 *   strict   → SoD is enforced; same-user approval is refused unless an
 *              admin has issued an override.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";

export type GovernanceMode = "solo" | "standard" | "strict";

export function useGovernanceMode() {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id ?? null;

  const q = useQuery({
    queryKey: ["org-governance-mode", orgId],
    enabled: !!orgId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("governance_mode")
        .eq("id", orgId!)
        .single();
      if (error) throw error;
      return (data?.governance_mode ?? "solo") as GovernanceMode;
    },
  });

  const mode: GovernanceMode = q.data ?? "solo";
  return {
    isLoading: q.isLoading,
    mode,
    isSolo: mode === "solo",
    isStrict: mode === "strict",
    isStandard: mode === "standard",
  };
}
