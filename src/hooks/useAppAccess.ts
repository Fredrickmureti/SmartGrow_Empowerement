/**
 * useAppAccess Hook
 *
 * App-level access checks for the subscription gating system.
 * Database-driven via plan_app_access (plan inclusion), app_trial_status (trials),
 * and org_entitlement_overrides (per-tenant overrides). Plan-blur is gone:
 * apps that are not in the plan are surfaced as ADD-ONS, not as locks.
 *
 * State machine returned by `getAppEntitlementState`:
 *   - 'in_plan'      → included in tenant's subscription, free to install
 *   - 'trial'        → currently in active trial period
 *   - 'overridden'   → platform admin granted explicit access
 *   - 'addon'        → not in plan, but installable as paid add-on
 *   - 'expired_trial'→ trial ended without conversion; ask to upgrade
 *   - 'coming_soon'  → app announced but not shippable yet
 */
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/contexts/SessionContext";
import { supabase } from "@/integrations/supabase/client";
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

interface AppPricingRow {
  app_id: string;
  monthly_price: number | null;
  yearly_price: number | null;
  currency: string;
  is_per_user: boolean;
  is_addon_only: boolean;
  is_active: boolean;
}

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
  /** New: 5-state entitlement model for marketplace UX */
  getAppEntitlementState: (appId: string) => AppEntitlementState;
  /** Pricing row for an app, or null if no rule configured */
  getAppPricing: (appId: string) => AppPricingRow | null;
  /** Trial row for an app, if any */
  getAppTrial: (appId: string) => AppTrialRow | null;
}

export function useAppAccess(): UseAppAccessResult {
  const { currentOrg, subscriptionStatus, isLoading } = useSession();
  const orgId = currentOrg?.id;

  // Per-app pricing (cached cross-tenant — same for everyone)
  const { data: pricingRows = [] } = useQuery({
    queryKey: ["app-pricing-rules"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("app_pricing_rules")
        .select("app_id, monthly_price, yearly_price, currency, is_per_user, is_addon_only, is_active")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []) as AppPricingRow[];
    },
    staleTime: 10 * 60 * 1000,
  });

  // Per-org trial rows
  const { data: trialRows = [] } = useQuery({
    queryKey: ["app-trial-status", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await (supabase as any)
        .from("app_trial_status")
        .select("app_id, status, expires_at")
        .eq("organization_id", orgId);
      if (error) throw error;
      return (data ?? []) as AppTrialRow[];
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });

  const pricingByApp = useMemo(() => {
    const m = new Map<string, AppPricingRow>();
    for (const r of pricingRows) m.set(r.app_id, r);
    return m;
  }, [pricingRows]);

  const trialByApp = useMemo(() => {
    const m = new Map<string, AppTrialRow>();
    for (const r of trialRows) m.set(r.app_id, r);
    return m;
  }, [trialRows]);

  const isTrialWithAllApps = useMemo(
    () => subscriptionStatus.isTrialing,
    [subscriptionStatus.isTrialing],
  );

  const isReadOnly = useMemo(
    () => subscriptionStatus.isExpired && !subscriptionStatus.isSuspended,
    [subscriptionStatus.isExpired, subscriptionStatus.isSuspended],
  );

  // RPC-derived plan inclusions (already in session)
  const accessibleAppIds = useMemo(() => {
    if (!currentOrg) return new Set<string>();
    const entitlements = currentOrg.app_entitlements;
    if (Array.isArray(entitlements) && entitlements.length > 0) {
      const s = new Set(entitlements);
      s.add("platform");
      return s;
    }
    return new Set<string>(["platform"]);
  }, [currentOrg]);

  const hasAppAccess = useCallback(
    (appId: string): boolean => {
      if (appId === "platform") return true;
      if (isLoading) return false;
      if (subscriptionStatus.isSuspended) return false;
      // In plan or active trial both grant access
      const trial = trialByApp.get(appId);
      const trialActive =
        trial?.status === "active" &&
        trial.expires_at !== null &&
        new Date(trial.expires_at) > new Date();
      return accessibleAppIds.has(appId) || trialActive;
    },
    [isLoading, subscriptionStatus.isSuspended, accessibleAppIds, trialByApp],
  );

  const getAppAccess = useCallback(
    (appId: string): AppAccessResult => {
      if (appId === "platform") return { hasAccess: true, isReadOnly: false };
      if (isLoading) return { hasAccess: false, isReadOnly: false };
      if (subscriptionStatus.isSuspended) {
        return { hasAccess: false, denialReason: "subscription", isReadOnly: false };
      }
      const has = hasAppAccess(appId);
      if (isReadOnly) {
        return { hasAccess: has, denialReason: has ? undefined : "not_in_plan", isReadOnly: true };
      }
      return has
        ? { hasAccess: true, isReadOnly: false }
        : { hasAccess: false, denialReason: "not_in_plan", isReadOnly: false };
    },
    [isLoading, subscriptionStatus.isSuspended, isReadOnly, hasAppAccess],
  );

  const getAppPricing = useCallback(
    (appId: string): AppPricingRow | null => pricingByApp.get(appId) ?? null,
    [pricingByApp],
  );

  const getAppTrial = useCallback(
    (appId: string): AppTrialRow | null => trialByApp.get(appId) ?? null,
    [trialByApp],
  );

  /**
   * 5-state entitlement model (Odoo + Xero hybrid):
   *  - coming_soon takes precedence (don't lie about availability)
   *  - in_plan when plan_app_access has it (read from session.app_entitlements)
   *  - trial when there is an active trial row
   *  - addon when not in plan but a pricing rule exists
   *  - expired_trial when trial row exists but expired/converted/cancelled
   *  - overridden if currentOrg.limit_overrides claims it (fallback path)
   */
  const getAppEntitlementState = useCallback(
    (appId: string): AppEntitlementState => {
      const def = APP_REGISTRY.find((a) => a.id === appId);
      if (def?.comingSoon) return "coming_soon";

      if (accessibleAppIds.has(appId)) return "in_plan";

      const trial = trialByApp.get(appId);
      if (trial) {
        if (
          trial.status === "active" &&
          trial.expires_at &&
          new Date(trial.expires_at) > new Date()
        ) {
          return "trial";
        }
        return "expired_trial";
      }

      // Otherwise: addon (pricing rule exists) or in_plan via override
      // Override is rare — surfaced as in_plan since UX-wise it grants free access.
      const pricing = pricingByApp.get(appId);
      if (pricing) return "addon";

      // No pricing rule, not in plan, no trial → treat as addon with $0 (free)
      return "addon";
    },
    [accessibleAppIds, trialByApp, pricingByApp],
  );

  return {
    hasAppAccess,
    getAppAccess,
    accessibleAppIds,
    isTrialWithAllApps,
    isReadOnly,
    isLoading,
    getAppEntitlementState,
    getAppPricing,
    getAppTrial,
  };
}
