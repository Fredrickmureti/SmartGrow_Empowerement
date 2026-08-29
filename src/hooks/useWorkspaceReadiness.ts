/**
 * useWorkspaceReadiness
 *
 * "Is the user's workspace actually queryable yet?"
 *
 * After complete_onboarding() returns, there is a small window where the
 * organization row exists but the SessionContext has not yet refetched
 * `get_user_session_data`, RLS hasn't caught up, or Realtime hasn't
 * delivered the membership event. Naively navigating to /home in that
 * window is what produces the "endless spinner with no organization
 * selected" symptom — InstitutionRoute renders a loader because
 * `currentOrg` is null and never recovers.
 *
 * This hook converts that race into a deterministic state machine:
 *
 *   loading → ready          (currentOrg resolved within timeout)
 *   loading → timed_out      (timeout elapsed, no org visible)
 *
 * It actively re-fetches the session on a backoff schedule and listens to
 * Realtime `user_roles` changes so the moment the membership row appears
 * we transition to `ready` without waiting for the next interval tick.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/contexts/BusinessContext";

export type ReadinessState = "idle" | "loading" | "ready" | "timed_out";

interface UseWorkspaceReadinessOptions {
  /** Activate the probe (e.g. only after onboarding RPC returns). */
  enabled: boolean;
  /** Total time to wait before declaring timeout. Default 12s. */
  timeoutMs?: number;
  /** If provided, only consider this specific organization id "ready". */
  expectedOrganizationId?: string | null;
  /**
   * Also require BusinessContext to have resolved at least one company.
   * /home and most module pages depend on `currentBusiness` to scope
   * queries; navigating before it lands produces an indefinite spinner
   * even though the org row exists. Defaults to true. Set false for
   * portal users / org-only flows where companies don't apply.
   */
  requireBusiness?: boolean;
}

export function useWorkspaceReadiness({
  enabled,
  timeoutMs = 12_000,
  expectedOrganizationId = null,
  requireBusiness = true,
}: UseWorkspaceReadinessOptions): {
  state: ReadinessState;
  retry: () => void;
} {
  const { user } = useAuth();
  const { sessionData, currentOrg, refreshSession } = useSession();
  const {
    currentBusiness,
    businesses,
    isLoading: businessLoading,
    refreshBusinesses,
  } = useBusinesses();
  const [state, setState] = useState<ReadinessState>("idle");
  const startedAtRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const isReady = useCallback(() => {
    if (!sessionData) return false;
    const orgReady = expectedOrganizationId
      ? sessionData.organizations.some((o) => o.id === expectedOrganizationId)
      : Boolean(currentOrg) || sessionData.organizations.length > 0;
    if (!orgReady) return false;
    if (!requireBusiness) return true;
    // Wait until BusinessContext has finished its initial fetch AND has
    // either selected a company or confirmed the workspace has one.
    if (businessLoading) return false;
    return Boolean(currentBusiness) || businesses.length > 0;
  }, [
    sessionData,
    currentOrg,
    expectedOrganizationId,
    requireBusiness,
    businessLoading,
    currentBusiness,
    businesses.length,
  ]);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const begin = useCallback(() => {
    cleanup();
    startedAtRef.current = Date.now();
    setState("loading");

    // Immediate refresh — never trust the stale snapshot.
    void refreshSession();
    if (requireBusiness) void refreshBusinesses();

    // Polling loop: backoff 500ms, 1s, 1.5s, 2s, 2s, 2s…
    let tick = 0;
    intervalRef.current = window.setInterval(() => {
      tick += 1;
      void refreshSession();
      // Also re-poke BusinessContext: an org may exist before the
      // user_business_access row lands due to RLS / Realtime lag.
      if (requireBusiness) void refreshBusinesses();
    }, 1_500);

    // Realtime: the moment a user_roles row appears for this user, refetch.
    if (user?.id) {
      try {
        channelRef.current = supabase
          .channel(`workspace-readiness-${user.id}`)
          .on(
            "postgres_changes" as never,
            {
              event: "INSERT",
              schema: "public",
              table: "user_roles",
              filter: `user_id=eq.${user.id}`,
            },
            () => {
              void refreshSession();
            },
          )
          .subscribe();
      } catch {
        /* Realtime not critical; polling will still resolve. */
      }
    }

    timeoutRef.current = window.setTimeout(() => {
      cleanup();
      setState((prev) => (prev === "ready" ? prev : "timed_out"));
    }, timeoutMs);
  }, [cleanup, refreshSession, refreshBusinesses, requireBusiness, user?.id, timeoutMs]);

  // Promote to ready as soon as the predicate matches.
  useEffect(() => {
    if (state === "loading" && isReady()) {
      cleanup();
      setState("ready");
    }
  }, [state, isReady, cleanup]);

  // Drive enabled → loading transition.
  useEffect(() => {
    if (!enabled) {
      cleanup();
      setState("idle");
      return;
    }
    // Already ready up-front — short-circuit.
    if (isReady()) {
      setState("ready");
      return;
    }
    begin();
    return cleanup;
    // begin/cleanup are stable refs of useCallback; isReady changes are
    // handled by the effect above. Re-running on every isReady tick would
    // restart the timer, defeating the timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, expectedOrganizationId]);

  return { state, retry: begin };
}
