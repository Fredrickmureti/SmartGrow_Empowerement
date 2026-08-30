/**
 * useAppAccess Hook
 *
 * Single-institution model: there are no subscription plans, trials,
 * add-ons or per-tenant entitlement overrides. Every app that ships in the
 * registry is available to the institution; *who* may use it is decided by
 * RBAC (roles + permissions), enforced server-side.
 *
 * The hook keeps its previous surface so callers (navigation, entitlement
 * gate, app cards) do not need to change: the state machine now only ever
 * resolves to `in_plan` (available) or `coming_soon` (not shippable yet).
 */
import { useCallback, useMemo } from "react";
import { APP_REGISTRY } from "@/lib/apps/registry";

export type AppEntitlementState =
  | "in_plan"
  | "trial"
  | "overridden"
  | "addon"
  | "expired_trial"
  | "coming_soon";

interface AppAccessResult {
  hasAccess: boolean;
  denialReason?: "subscription" | "trial_expired" | "not_in_plan";
  isReadOnly: boolean;
}

/** Retained for type-compatibility with call sites; always null now. */
interface AppPricingRow {
  app_id: string;
  monthly_price: number | null;
  yearly_price: number | null;
  currency: string;
  is_per_user: boolean;
  is_addon_only: boolean;
  is_active: boolean;
}

/** Retained for type-compatibility with call sites; always null now. */
interface AppTrialRow {
  app_id: string;
  status: "active" | "expired" | "converted" | "cancelled";
  expires_at: string | null;
}

interface UseAppAccessResult {
  hasAppAccess: (appId: string) => boolean;
  getAppAccess: (appId: string) => AppAccessResult;
  accessibleAppIds: Set<string>;
  isTrialWithAllApps: boolean;
  isReadOnly: boolean;
  isLoading: boolean;
  getAppEntitlementState: (appId: string) => AppEntitlementState;
  getAppPricing: (appId: string) => AppPricingRow | null;
  getAppTrial: (appId: string) => AppTrialRow | null;
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
    (appId: string): AppAccessResult =>
      hasAppAccess(appId)
        ? { hasAccess: true, isReadOnly: false }
        : { hasAccess: false, denialReason: "not_in_plan", isReadOnly: false },
    [hasAppAccess],
  );

  const getAppEntitlementState = useCallback(
    (appId: string): AppEntitlementState => {
      const def = APP_REGISTRY.find((a) => a.id === appId);
      if (def?.comingSoon) return "coming_soon";
      return "in_plan";
    },
    [],
  );

  return {
    hasAppAccess,
    getAppAccess,
    accessibleAppIds,
    isTrialWithAllApps: false,
    isReadOnly: false,
    isLoading: false,
    getAppEntitlementState,
    getAppPricing: () => null,
    getAppTrial: () => null,
  };
}
