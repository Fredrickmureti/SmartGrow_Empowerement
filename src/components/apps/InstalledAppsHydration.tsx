/**
 * InstalledAppsHydration — single mount point that keeps the
 * `["installed-apps", orgId]` React Query cache in sync with
 * authoritative server state across every meaningful boundary.
 *
 * Mount ONCE inside the provider tree (after SessionProvider so we
 * have `currentOrg`, and inside the QueryClientProvider). This
 * component renders nothing.
 *
 * Triggers a refetch on:
 *   - `currentOrg.id` changes (org switch).
 *   - Supabase auth state changes (`SIGNED_IN`, `TOKEN_REFRESHED`,
 *     `USER_UPDATED`) — covers session-restore after a sleep/refresh.
 *   - `online` window event — offline-to-online transitions.
 *   - Realtime `postgres_changes` on `organization_installed_apps`
 *     filtered by `organization_id=eq.<orgId>` — so an install /
 *     uninstall performed in another tab or by an admin propagates
 *     immediately without waiting for `staleTime`.
 *
 * Why a component, not a hook inside `useInstalledApps`:
 *   - Avoids spawning N realtime channels and N auth listeners when
 *     multiple components consume the hook.
 *   - Keeps the hydration policy as a single, auditable place.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";

export function InstalledAppsHydration() {
  const queryClient = useQueryClient();
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id ?? null;

  useEffect(() => {
    if (!orgId) return;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["installed-apps", orgId] });
    };

    // Initial refresh on org boundary — guarantees the first
    // authoritative answer is in flight the moment we know which org
    // we're rendering for.
    invalidate();

    // Auth-state changes: most importantly TOKEN_REFRESHED (rotating
    // the bearer token while a stale query result is sitting in cache)
    // and SIGNED_IN (session-restore on app open).
    const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
      if (
        event === "SIGNED_IN" ||
        event === "TOKEN_REFRESHED" ||
        event === "USER_UPDATED" ||
        event === "INITIAL_SESSION"
      ) {
        invalidate();
      }
    });

    // Offline → online.
    const handleOnline = () => invalidate();
    window.addEventListener("online", handleOnline);

    // Realtime: install / uninstall performed in another tab or by
    // another admin reaches us within ~hundreds of ms.
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel(`installed-apps-hydration-${orgId}`)
        .on(
          "postgres_changes" as never,
          {
            event: "*",
            schema: "public",
            table: "organization_installed_apps",
            filter: `organization_id=eq.${orgId}`,
          },
          () => invalidate(),
        )
        .subscribe();
    } catch {
      /* Realtime is optional; the polling/refetch paths above are
         sufficient to keep correctness. */
    }

    return () => {
      authSub.subscription.unsubscribe();
      window.removeEventListener("online", handleOnline);
      if (channel) {
        try {
          supabase.removeChannel(channel);
        } catch {
          /* ignore */
        }
      }
    };
  }, [orgId, queryClient]);

  return null;
}
