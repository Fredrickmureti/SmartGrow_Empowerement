/**
 * useAppAccess Hook
 *
 * Single-institution model: there are no subscription plans, trials,
 * add-ons or per-tenant entitlements. Every app that ships in the registry
 * is available to the institution; *who* may use it is decided by RBAC
 * (roles + permissions), enforced server-side.
 */
import { useCallback, useMemo } from "react";
import { APP_REGISTRY } from "@/lib/apps/registry";

interface AppAccessResult {
  hasAccess: boolean;
  denialReason?: "coming_soon" | "unknown_app";
}

interface UseAppAccessResult {
  hasAppAccess: (appId: string) => boolean;
  getAppAccess: (appId: string) => AppAccessResult;
  accessibleAppIds: Set<string>;
  isLoading: boolean;
}

export function useAppAccess(): UseAppAccessResult {
  const accessibleAppIds = useMemo(() => {
    const ids = new Set<string>(
      APP_REGISTRY.filter((app) => !app.comingSoon).map((app) => app.id),
    );
    ids.add("platform");
    return ids;
  }, []);

  const hasAppAccess = useCallback(
    (appId: string): boolean => appId === "platform" || accessibleAppIds.has(appId),
    [accessibleAppIds],
  );

  const getAppAccess = useCallback(
    (appId: string): AppAccessResult => {
      if (hasAppAccess(appId)) return { hasAccess: true };
      const known = APP_REGISTRY.some((a) => a.id === appId);
      return { hasAccess: false, denialReason: known ? "coming_soon" : "unknown_app" };
    },
    [hasAppAccess],
  );

  return { hasAppAccess, getAppAccess, accessibleAppIds, isLoading: false };
}
