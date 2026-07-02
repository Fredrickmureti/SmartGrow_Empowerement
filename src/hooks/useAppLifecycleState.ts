/**
 * useAppLifecycleState
 *
 * Thin React wrapper around the `app_state_for_org(org, app)` Postgres
 * function. Returns the canonical lifecycle state used everywhere:
 *
 *   not_installed | active | trial | grace | read_only | expired_trial | suspended
 *
 * Use this when you need the *authoritative* server view (e.g. to disable
 * write actions when a subscription has lapsed and the org is read-only).
 * For pure UX gating that mirrors plan/installed/trial state, prefer
 * `useEntitlementGate` — this hook is the underlying source of truth.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";

export type AppLifecycleState =
  | "not_installed"
  | "active"
  | "trial"
  | "grace"
  | "read_only"
  | "expired_trial"
  | "suspended";

interface Result {
  state: AppLifecycleState;
  isLoading: boolean;
  /** True when the org is allowed to perform write actions for this app. */
  canWrite: boolean;
  /** True when read-only views over historical data should still be shown. */
  canRead: boolean;
}

const WRITE_OK: AppLifecycleState[] = ["active", "trial", "grace"];
const READ_OK: AppLifecycleState[] = ["active", "trial", "grace", "read_only", "expired_trial"];

export function useAppLifecycleState(appId: string | undefined): Result {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["app-lifecycle-state", orgId, appId],
    queryFn: async (): Promise<AppLifecycleState> => {
      if (!orgId || !appId) return "not_installed";
      const { data, error } = await (supabase as any).rpc("app_state_for_org", {
        _org_id: orgId,
        _app_id: appId,
      });
      if (error) throw error;
      return (data as AppLifecycleState) ?? "not_installed";
    },
    enabled: !!orgId && !!appId,
    staleTime: 30 * 1000,
  });

  const state = data ?? "not_installed";
  return {
    state,
    isLoading,
    canWrite: WRITE_OK.includes(state),
    canRead: READ_OK.includes(state),
  };
}
