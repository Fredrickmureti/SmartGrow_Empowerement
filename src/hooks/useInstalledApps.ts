/**
 * useInstalledApps Hook
 *
 * Manages organization app installation state. The cache is the single
 * source of truth — but consumers must treat "still fetching" as a
 * non-answer, NOT as "nothing is installed".
 *
 * Architectural contract (workspace install-state hydration):
 *
 *   isReady === true   →  the rows reflect an authoritative server fetch
 *                         for the CURRENT orgId. Safe to gate UI on
 *                         isInstalled(...).
 *   isReady === false  →  we have not yet confirmed install state for
 *                         this org. Surfaces that *change content*
 *                         based on isInstalled (gates, install prompts,
 *                         landing pages) MUST render a loader, not the
 *                         "not installed" branch. Surfaces that only
 *                         decorate (badges, sorts) may read isInstalled
 *                         optimistically.
 *
 * The previous implementation used React Query's `placeholderData` which
 * makes `isLoading=false` even on a fresh device with an empty cache —
 * causing install gates to redirect already-installed tenants to the
 * activate screen during the hydration window. We now use `initialData`
 * (a true cache hit, only when the cache belongs to the current org and
 * is within TTL) so `isPending`/`isLoading` honestly reflect "we are
 * still waiting for the server".
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { APP_REGISTRY } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";
import { usePlatformApps, getCoreAppIds, getDefaultAppIds as getDefaultAppIdsFromDB } from "@/hooks/usePlatformApps";

export interface InstalledApp {
  id: string;
  organization_id: string;
  app_id: string;
  installed_at: string;
  installed_by: string | null;
  is_active: boolean;
  settings: Record<string, unknown>;
  last_accessed_at: string | null;
}

interface UseInstalledAppsResult {
  // Data
  installedApps: InstalledApp[];
  installedAppIds: Set<string>;
  isLoading: boolean;
  isError: boolean;
  /**
   * Authoritative readiness. True only after a successful server fetch
   * for the current orgId (or initial-data hit from a fresh same-org
   * cache). NEVER short-circuit install-gating UI on `!isLoading` —
   * use `isReady`.
   */
  isReady: boolean;
  /**
   * True iff a fresh same-org cache populated React Query `initialData`
   * on mount. Consumed by `useWorkspaceContextReady` to allow offline
   * first-paint when the network is down but we have a warm snapshot.
   */
  hasInitialSnapshot: boolean;

  // Queries
  isInstalled: (appId: string) => boolean;
  canUninstall: (appId: string) => boolean;
  getInstalledApp: (appId: string) => InstalledApp | undefined;

  // Mutations
  installApp: (appId: string) => Promise<void>;
  uninstallApp: (appId: string) => Promise<void>;
  updateAppSettings: (appId: string, settings: Record<string, unknown>) => Promise<void>;
  trackAppAccess: (appId: string) => void;

  // Batch operations
  installApps: (appIds: string[]) => Promise<void>;

  // Utilities
  getAvailableAppsToInstall: () => AppDefinition[];
}

/**
 * One-shot session-scoped warning set. Prevents `console.warn` spam when a
 * consumer reads `isInstalled(appId)` before `isReady === true`. The first
 * occurrence per `${orgId}:${appId}` is logged so QA / code review surfaces
 * contract violations without flooding the console during legitimate
 * rapid re-renders.
 */
const PRE_READY_WARN_SEEN = new Set<string>();

/** localStorage cache shape. Versioned so we can evolve without confusion. */
interface InstalledAppsCacheEnvelope {
  v: 2;
  orgId: string;
  fetchedAt: number; // epoch ms
  rows: InstalledApp[];
}

const CACHE_PREFIX = "installed-apps-cache-v2-";
const LEGACY_CACHE_PREFIX = "installed-apps-cache-";
/**
 * TTL for promoting cached rows to React Query `initialData`. The cache
 * is only a warm-start optimization — the query refetches immediately
 * regardless, so this only affects the *first* paint while the network
 * round-trip is in flight. Long-lived enough to cover a normal session
 * restart, short enough that genuinely stale data does not survive for
 * days across uninstalls.
 */
const CACHE_INITIAL_DATA_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function readCacheEnvelope(orgId: string): InstalledAppsCacheEnvelope | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${orgId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InstalledAppsCacheEnvelope;
    if (!parsed || parsed.v !== 2 || parsed.orgId !== orgId || !Array.isArray(parsed.rows)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCacheEnvelope(orgId: string, rows: InstalledApp[]) {
  try {
    const envelope: InstalledAppsCacheEnvelope = {
      v: 2,
      orgId,
      fetchedAt: Date.now(),
      rows,
    };
    localStorage.setItem(`${CACHE_PREFIX}${orgId}`, JSON.stringify(envelope));
    // Best-effort cleanup of the legacy unversioned cache so it cannot
    // be picked up by older code paths.
    localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${orgId}`);
  } catch {
    /* ignore storage errors */
  }
}

function clearCache(orgId: string) {
  try {
    localStorage.removeItem(`${CACHE_PREFIX}${orgId}`);
    localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${orgId}`);
  } catch {
    /* ignore */
  }
}

export function useInstalledApps(): UseInstalledAppsResult {
  const { currentOrg, hasEntitlement } = useSession();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  // Fetch core app IDs from platform_apps DB table
  const { data: platformApps } = usePlatformApps();
  const coreAppIds = useMemo(() => getCoreAppIds(platformApps), [platformApps]);

  // Clear the previous org's cached apps when the active org switches.
  // Without this, multi-org users can see stale cross-tenant rows.
  const prevOrgIdRef = useRef<string | undefined>(orgId);
  useEffect(() => {
    const prev = prevOrgIdRef.current;
    if (prev && prev !== orgId) {
      clearCache(prev);
    }
    prevOrgIdRef.current = orgId;
  }, [orgId]);

  // Resolve a fresh-enough cache envelope for the CURRENT org to use as
  // React Query `initialData`. We deliberately do NOT use `placeholderData`
  // here — placeholder data sets `isPending=false` even when there is no
  // real cache, which is exactly the hydration race the workspace install
  // gate suffered from.
  const cacheEnvelope = useMemo<InstalledAppsCacheEnvelope | null>(() => {
    if (!orgId) return null;
    const env = readCacheEnvelope(orgId);
    if (!env) return null;
    if (Date.now() - env.fetchedAt > CACHE_INITIAL_DATA_TTL_MS) return null;
    return env;
    // We intentionally only re-read this when orgId changes. The cache is
    // also updated by the queryFn below; consumers see fresh data via the
    // query result, not by re-reading localStorage on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Fetch installed apps for current organization
  const query = useQuery({
    queryKey: ["installed-apps", orgId],
    queryFn: async () => {
      if (!orgId) return [];

      const { data, error } = await supabase
        .from("organization_installed_apps")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .order("installed_at", { ascending: true });

      if (error) {
        console.error("Error fetching installed apps:", error);
        throw error;
      }

      const rows = (data ?? []) as InstalledApp[];
      writeCacheEnvelope(orgId, rows);
      return rows;
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    initialData: cacheEnvelope?.rows,
    initialDataUpdatedAt: cacheEnvelope?.fetchedAt,
  });

  const installedApps = (query.data ?? []) as InstalledApp[];
  const isLoading = query.isLoading;
  const isError = query.isError;

  /**
   * Authoritative readiness. True iff:
   *   - we have an orgId to query for,
   *   - AND either the network fetch has succeeded at least once, or we
   *     are warm-starting from a fresh same-org cache (which the queryFn
   *     itself will re-confirm in the background).
   *
   * We deliberately do NOT consider `isError` as ready — a network failure
   * is not an authoritative "not installed" answer.
   */
  const isReady =
    !!orgId &&
    (query.isFetched || (query.isSuccess && !query.isFetching && installedApps.length >= 0 && !!cacheEnvelope));

  // Convert to Set for O(1) lookup
  const installedAppIds = useMemo(() => {
    return new Set(installedApps.map(app => app.app_id));
  }, [installedApps]);

  // Check if an app is installed.
  // Core/platform apps are ALWAYS treated as installed by definition — they
  // are the foundation of every workspace. This prevents the install gate
  // from locking foundational surfaces (Finance, Contacts, Settings) for
  // legacy tenants whose `organization_installed_apps` rows were never
  // backfilled. Note: this fallback is only correct once `usePlatformApps`
  // has resolved; surfaces that gate on install state must consult
  // `useWorkspaceContextReady()` so this hook never reports false-negatives
  // for core apps during the platform-apps hydration window.
  const isInstalled = useCallback((appId: string): boolean => {
    if (!isReady) {
      const key = `${orgId ?? "noorg"}:${appId}`;
      if (!PRE_READY_WARN_SEEN.has(key)) {
        PRE_READY_WARN_SEEN.add(key);
        console.warn(
          "[useInstalledApps] isInstalled() called before isReady=true — " +
            "gate this surface on useWorkspaceContextReady() instead.",
          { appId, orgId, hasInitialSnapshot: !!cacheEnvelope },
        );
      }
    }
    if (coreAppIds.includes(appId)) return true;
    return installedAppIds.has(appId);
  }, [installedAppIds, coreAppIds, isReady, orgId, cacheEnvelope]);

  // Check if an app can be uninstalled (core apps cannot)
  const canUninstall = useCallback((appId: string): boolean => {
    return !coreAppIds.includes(appId);
  }, [coreAppIds]);

  // Get installed app record
  const getInstalledApp = useCallback((appId: string): InstalledApp | undefined => {
    return installedApps.find(app => app.app_id === appId);
  }, [installedApps]);

  // Install app mutation
  const installMutation = useMutation({
    mutationFn: async (appId: string) => {
      if (!orgId || !user?.id) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("install_app", {
        p_org_id: orgId,
        p_app_id: appId,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (_, appId) => {
      queryClient.invalidateQueries({ queryKey: ["installed-apps", orgId] });
      const app = APP_REGISTRY.find(a => a.id === appId);
      toast.success(`${app?.name || appId} installed successfully`);
    },
    onError: (error, appId) => {
      console.error("Error installing app:", error);
      const app = APP_REGISTRY.find(a => a.id === appId);
      const appName = app?.name || appId;
      const raw = (error as Error & { message?: string })?.message ?? "";

      const code = (error as { code?: string })?.code;
      const isOverloadAmbiguity =
        code === "42725" || /is not unique/i.test(raw);

      let friendly: string;
      if (isOverloadAmbiguity) {
        console.error("[install_app] DB function ambiguity — please report", { appId, raw });
        friendly = `${appName} couldn't install due to a backend configuration issue. Our team has been notified.`;
      } else if (raw.includes("ENTITLEMENT_REQUIRED")) {
        const stripped = raw.replace(/^.*ENTITLEMENT_REQUIRED:\s*/i, "").trim();
        friendly = stripped || `${appName} is not included in your plan. Start a 14-day trial or upgrade to install it.`;
      } else if (raw.includes("SETUP_REQUIRED")) {
        const stripped = raw.replace(/^.*SETUP_REQUIRED:\s*/i, "").trim();
        friendly = stripped || `${appName} requires additional setup before it can be installed.`;
      } else if (raw.toLowerCase().includes("unauthorized")) {
        friendly = `You don't have permission to install ${appName}. Ask an organization owner or admin.`;
      } else {
        friendly = `Couldn't install ${appName}. Please try again or contact support.`;
      }
      toast.error(friendly);

      // Clear stale localStorage cache to prevent navigation leak. The
      // refetch below will repopulate it from authoritative server state.
      if (orgId) clearCache(orgId);
      queryClient.invalidateQueries({ queryKey: ["installed-apps", orgId] });
    },
  });

  // Uninstall app mutation
  const uninstallMutation = useMutation({
    mutationFn: async (appId: string) => {
      if (!orgId) throw new Error("No organization selected");

      if (coreAppIds.includes(appId)) {
        throw new Error("Cannot uninstall core apps");
      }

      const { data, error } = await supabase.rpc("uninstall_app", {
        p_org_id: orgId,
        p_app_id: appId,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (_, appId) => {
      queryClient.invalidateQueries({ queryKey: ["installed-apps", orgId] });
      const app = APP_REGISTRY.find(a => a.id === appId);
      toast.success(`${app?.name || appId} uninstalled`);
    },
    onError: (error, appId) => {
      console.error("Error uninstalling app:", error);
      const app = APP_REGISTRY.find(a => a.id === appId);
      const appName = app?.name || appId;
      const raw = (error as Error & { message?: string })?.message ?? "";
      let friendly: string;
      if (raw.includes("DEPENDENCY_BLOCKED")) {
        const stripped = raw.replace(/^.*DEPENDENCY_BLOCKED:\s*/i, "").trim();
        friendly = stripped || `${appName} is required by other installed apps. Uninstall those first.`;
      } else {
        friendly = `Couldn't uninstall ${appName}: ${error.message}`;
      }
      toast.error(friendly);
    },
  });

  // Update app settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: async ({ appId, settings }: { appId: string; settings: Record<string, unknown> }) => {
      if (!orgId) throw new Error("No organization selected");

      const { error } = await supabase
        .from("organization_installed_apps")
        .update({ settings: JSON.parse(JSON.stringify(settings)) })
        .eq("organization_id", orgId)
        .eq("app_id", appId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["installed-apps", orgId] });
    },
    onError: (error) => {
      console.error("Error updating app settings:", error);
      toast.error("Failed to update app settings");
    },
  });

  const installApp = useCallback(async (appId: string) => {
    if (!isInstalled(appId)) {
      await installMutation.mutateAsync(appId);
    }
  }, [installMutation, isInstalled]);

  const uninstallApp = useCallback(async (appId: string) => {
    await uninstallMutation.mutateAsync(appId);
  }, [uninstallMutation, installedAppIds]);

  const updateAppSettings = useCallback(async (appId: string, settings: Record<string, unknown>) => {
    await updateSettingsMutation.mutateAsync({ appId, settings });
  }, [updateSettingsMutation]);

  const trackAppAccess = useCallback((appId: string) => {
    if (!orgId) return;
    supabase.rpc("update_app_last_accessed", {
      p_org_id: orgId,
      p_app_id: appId,
    }).then(({ error }) => {
      if (error) console.warn("Failed to track app access:", error);
    });
  }, [orgId]);

  const installApps = useCallback(async (appIds: string[]) => {
    if (!orgId || !user?.id) throw new Error("Not authenticated");
    for (const appId of appIds) {
      if (!isInstalled(appId)) {
        await installMutation.mutateAsync(appId);
      }
    }
  }, [orgId, user?.id, isInstalled, installMutation]);

  const getAvailableAppsToInstall = useCallback((): AppDefinition[] => {
    return APP_REGISTRY.filter(app => {
      if (isInstalled(app.id)) return false;
      if (app.isPlatform) return false;
      if (app.feature && !hasEntitlement(app.feature)) return false;
      return true;
    });
  }, [isInstalled, hasEntitlement]);

  return {
    installedApps,
    installedAppIds,
    isLoading,
    isError,
    isReady,
    hasInitialSnapshot: !!cacheEnvelope,
    isInstalled,
    canUninstall,
    getInstalledApp,
    installApp,
    uninstallApp,
    updateAppSettings,
    trackAppAccess,
    installApps,
    getAvailableAppsToInstall,
  };
}

/**
 * Hook to get just the installed app IDs (lighter query)
 */
export function useInstalledAppIds(): Set<string> {
  const { installedAppIds } = useInstalledApps();
  return installedAppIds;
}

/**
 * Utility to check if default apps should be auto-installed.
 * Note: For DB-driven defaults, use getDefaultAppIds from usePlatformApps hook.
 */
export function getDefaultAppIds(): string[] {
  return getDefaultAppIdsFromDB(undefined);
}

export { getCoreAppIds, getDefaultAppIdsFromDB as getDefaultAppIdsFromPlatform };
