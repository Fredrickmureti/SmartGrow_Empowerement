/**
 * useTenantReadiness
 *
 * "Is this tenant fully provisioned and queryable as the current user?"
 *
 * Used to gate destructive / provisioning-sensitive actions (e.g. installing
 * a localization pack, seeding payroll periods) on pages a freshly signed-up
 * user can land on before the bootstrap chain (profiles → organizations →
 * businesses → user_roles) has fully settled.
 *
 * It is a thin, opinionated wrapper around `useWorkspaceReadiness` that:
 *   - Auto-enables itself (no manual `enabled` toggle needed).
 *   - Pins the expected organization to the current business's org so we
 *     don't accept a stale membership from a previously selected workspace.
 *   - Surfaces a single boolean `isReady` plus the underlying state for
 *     finer-grained UI (Finishing setup… / retry / timed out).
 *
 * This is the user-facing safety net layered on top of the already-atomic
 * `complete_onboarding` RPC. The RPC guarantees that *if* it returned
 * successfully every required row was committed; this hook guarantees the
 * *client* has observed those rows via SessionContext + BusinessContext
 * before letting the user fire an authenticated edge function that depends
 * on them. Together they remove the fresh-tenant 401 / 403 race window.
 */
import { useMemo } from "react";
import { useWorkspaceReadiness, type ReadinessState } from "@/hooks/useWorkspaceReadiness";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";

export interface UseTenantReadinessOptions {
  /**
   * If true, also require BusinessContext to have at least one company
   * resolved. Defaults to true — set false for org-only flows (e.g. the
   * onboarding pack prompt that runs before any business exists).
   */
  requireBusiness?: boolean;
  /** Timeout before reporting `timed_out`. Default 12s. */
  timeoutMs?: number;
}

export interface TenantReadiness {
  /** Convenience flag — true iff `state === "ready"`. */
  isReady: boolean;
  /** Full state machine, useful for distinct UI per state. */
  state: ReadinessState;
  /** Re-arm the readiness probe (button-driven retry). */
  retry: () => void;
  /** Human-readable explanation of why we're not ready (or empty). */
  reason: string;
}

export function useTenantReadiness(
  options: UseTenantReadinessOptions = {},
): TenantReadiness {
  const { requireBusiness = true, timeoutMs = 12_000 } = options;
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();

  const expectedOrganizationId = requireBusiness
    ? currentBusiness?.organization_id ?? null
    : null;

  const { state, retry } = useWorkspaceReadiness({
    enabled: Boolean(user?.id),
    expectedOrganizationId,
    requireBusiness,
    timeoutMs,
  });

  const reason = useMemo(() => {
    if (!user?.id) return "Not signed in.";
    if (state === "ready") return "";
    if (state === "timed_out") {
      return "Tenant provisioning is taking longer than expected.";
    }
    if (requireBusiness && !currentBusiness) {
      return "Finishing company setup…";
    }
    return "Finishing tenant setup…";
  }, [user?.id, state, requireBusiness, currentBusiness]);

  return {
    isReady: state === "ready",
    state,
    retry,
    reason,
  };
}
