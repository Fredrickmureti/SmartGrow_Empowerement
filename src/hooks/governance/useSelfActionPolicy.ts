/**
 * useSelfActionPolicy — reads the per-org `self_action_policy` row for a
 * given action_key and returns the effective mode + helpers for the UI.
 *
 * Modes match `SELF_ACTION_MODES` in the catalogue:
 *   block          → refuse self-approval (default when no row exists)
 *   require_cosign → block unless an owner has issued a one-time override
 *   warn           → allow but log a security event
 *   allow          → no restriction
 *
 * Resolution: we look up the row by (organization_id, action_key). The
 * `applies_to_role` dimension is left to the DB-side guard
 * (`governance_assert_not_self`) — the UI only needs the mode so it can
 * decide between disabling, offering override, or letting through.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export type SelfActionMode = "block" | "require_cosign" | "warn" | "allow";

export interface SelfActionPolicyResult {
  isLoading: boolean;
  mode: SelfActionMode;
  /** Policy exists in the DB. When false, `mode` is the safe default ("block"). */
  hasPolicy: boolean;
  /** Convenience for callers: can the same user act on their own record? */
  canSelfAct: boolean;
  /** Convenience: should the UI surface an "override" CTA? */
  needsOverride: boolean;
}

const VALID_MODES: SelfActionMode[] = ["block", "require_cosign", "warn", "allow"];

export function useSelfActionPolicy(actionKey: string | null | undefined): SelfActionPolicyResult {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;

  const q = useQuery({
    queryKey: ["self-action-policy", orgId, actionKey],
    enabled: !!orgId && !!actionKey,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("self_action_policy")
        .select("mode")
        .eq("organization_id", orgId!)
        .eq("action_key", actionKey!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const rawMode = (q.data?.mode ?? "") as string;
  const mode: SelfActionMode = (VALID_MODES.includes(rawMode as SelfActionMode)
    ? (rawMode as SelfActionMode)
    : "block");
  const hasPolicy = !!q.data;

  return {
    isLoading: q.isLoading,
    mode,
    hasPolicy,
    canSelfAct: mode === "warn" || mode === "allow",
    needsOverride: mode === "require_cosign",
  };
}
