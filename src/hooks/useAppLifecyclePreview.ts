/**
 * useAppLifecyclePreview
 *
 * Wraps the `preview_install_impact` RPC to power the install preflight dialog.
 * The RPC returns: { app_id, all_dependencies, will_be_installed, missing_entitlements, can_install }
 *
 * This hook augments those raw arrays with display data (app names, billing
 * labels) by joining client-side against the platform_apps catalog and
 * app_pricing_rules — both of which are already cached cross-tenant.
 *
 * Also exposes a reverse-dependency lookup for the uninstall safety dialog —
 * "Cannot uninstall Inventory: POS depends on it."
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { usePlatformApps } from "@/hooks/usePlatformApps";
import { useCurrencyMap } from "@/hooks/useCurrencyMap";
import { formatAppPrice } from "@/lib/pricing/formatAppPrice";

export type DependencyType = "required" | "optional" | "auto_install" | "setup_only";
export type BillingBehavior = "in_plan" | "addon" | "trial_eligible" | "already_installed";

export interface InstallPreviewLine {
  app_id: string;
  app_name: string;
  /** True when this is the user-clicked app, false for transitive deps */
  is_root: boolean;
  /** Currently installed for this org? */
  is_installed: boolean;
  /** Will be installed by this action (not already installed) */
  will_install: boolean;
  /** Whether the org is entitled to install this without paying / trialing */
  is_entitled: boolean;
  /** Billing impact summary line shown to the user */
  billing_label: string;
  billing_behavior: BillingBehavior;
}

export interface InstallPreview {
  root_app_id: string;
  lines: InstallPreviewLine[];
  /** Number of apps that will actually install (excluding already-installed) */
  apps_to_install: number;
  /** Apps where the user is not entitled — install will fail unless they pay */
  missing_entitlements: string[];
  /** True when install_app would succeed end-to-end */
  can_install: boolean;
}

interface RawPreview {
  app_id: string;
  all_dependencies: string[];
  will_be_installed: string[];
  missing_entitlements: string[];
  can_install: boolean;
}

interface PricingRule {
  app_id: string;
  monthly_price: number | null;
  currency: string;
  is_addon_only: boolean;
}

/**
 * Fetch install impact preview from the DB.
 * Disabled until appId is provided; intended for use inside the dialog.
 */
export function useInstallPreview(appId: string | null) {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id;
  const { data: platformApps = [] } = usePlatformApps();
  const { currencyMap } = useCurrencyMap();

  const { data: pricingRows = [] } = useQuery({
    queryKey: ["app-pricing-rules"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("app_pricing_rules")
        .select("app_id, monthly_price, currency, is_addon_only")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []) as PricingRule[];
    },
    staleTime: 10 * 60 * 1000,
  });

  const previewQuery = useQuery({
    queryKey: ["install-preview", orgId, appId],
    queryFn: async (): Promise<RawPreview | null> => {
      if (!orgId || !appId) return null;
      const { data, error } = await (supabase as any).rpc("preview_install_impact", {
        p_org_id: orgId,
        p_app_id: appId,
      });
      if (error) throw error;
      return data as RawPreview;
    },
    enabled: !!orgId && !!appId,
    staleTime: 30 * 1000,
  });

  const composed: InstallPreview | null = useMemo(() => {
    if (!previewQuery.data || !appId) return null;

    const raw = previewQuery.data;
    const willInstallSet = new Set(raw.will_be_installed);
    const missingSet = new Set(raw.missing_entitlements);
    const nameById = new Map(platformApps.map((a) => [a.id, a.name]));
    const priceById = new Map(pricingRows.map((p) => [p.app_id, p]));

    const lines: InstallPreviewLine[] = (raw.all_dependencies || []).map((id) => {
      const isRoot = id === appId;
      const willInstall = willInstallSet.has(id);
      const isInstalled = !willInstall;
      const isEntitled = !missingSet.has(id);
      const price = priceById.get(id);

      let billing_label: string;
      let billing_behavior: BillingBehavior;

      if (isInstalled) {
        billing_label = "Already installed";
        billing_behavior = "already_installed";
      } else if (isEntitled) {
        billing_label = "Included in your plan";
        billing_behavior = "in_plan";
      } else if (price && price.monthly_price && price.monthly_price > 0) {
        const displayPrice = formatAppPrice(Number(price.monthly_price), price.currency, {}, currencyMap);
        billing_label = `Add-on: ${displayPrice} or 14-day free trial`;
        billing_behavior = "trial_eligible";
      } else {
        billing_label = "Add-on: paid plan required";
        billing_behavior = "addon";
      }

      return {
        app_id: id,
        app_name: nameById.get(id) ?? id,
        is_root: isRoot,
        is_installed: isInstalled,
        will_install: willInstall,
        is_entitled: isEntitled,
        billing_label,
        billing_behavior,
      };
    });

    // Sort: root last (so prerequisites show first); installed first within group
    lines.sort((a, b) => {
      if (a.is_root !== b.is_root) return a.is_root ? 1 : -1;
      if (a.is_installed !== b.is_installed) return a.is_installed ? -1 : 1;
      return a.app_name.localeCompare(b.app_name);
    });

    return {
      root_app_id: raw.app_id,
      lines,
      apps_to_install: raw.will_be_installed.length,
      missing_entitlements: raw.missing_entitlements,
      can_install: raw.can_install,
    };
  }, [previewQuery.data, appId, platformApps, pricingRows, currencyMap]);

  return {
    preview: composed,
    isLoading: previewQuery.isLoading,
    error: previewQuery.error,
  };
}

export interface UninstallBlocker {
  blocking_app_id: string;
  blocking_app_name: string;
}

/**
 * Look up which installed apps depend on the target app.
 * Used by uninstall dialog to show the user what's blocking removal.
 */
export function useUninstallBlockers(appId: string | null) {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id;
  const { data: platformApps = [] } = usePlatformApps();

  return useQuery({
    queryKey: ["uninstall-blockers", orgId, appId],
    queryFn: async (): Promise<UninstallBlocker[]> => {
      if (!orgId || !appId) return [];

      const { data: deps, error: depsErr } = await (supabase as any)
        .from("app_dependencies")
        .select("app_id")
        .eq("depends_on_app_id", appId)
        .in("dependency_type", ["required", "auto_install"]);
      if (depsErr) throw depsErr;
      if (!deps?.length) return [];

      const dependentIds = deps.map((d: any) => d.app_id);

      const { data: installed, error: instErr } = await (supabase as any)
        .from("organization_installed_apps")
        .select("app_id")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .in("app_id", dependentIds);
      if (instErr) throw instErr;

      const installedIds = (installed ?? []).map((r: any) => r.app_id);
      if (installedIds.length === 0) return [];

      const nameById = new Map(platformApps.map((a) => [a.id, a.name]));
      return installedIds.map((id: string) => ({
        blocking_app_id: id,
        blocking_app_name: nameById.get(id) ?? id,
      }));
    },
    enabled: !!orgId && !!appId,
    staleTime: 30 * 1000,
  });
}
