/**
 * Active-company guard.
 *
 * Mounted at the top of every operational app layout (Finance, Sales,
 * Purchases, Inventory, HR, POS) to ensure a Company is selected before any
 * company-scoped query runs.
 *
 * Without this guard, the contamination risk catalogued in the audit
 * resurfaces every time a developer forgets the `currentBusiness` check.
 */
import { useEffect } from "react";
import { useBusinesses } from "./useBusinesses";
import { useOrganization } from "./useOrganization";
import { toast } from "sonner";

interface RequireActiveBusinessOptions {
  enabled?: boolean;
}

export function useRequireActiveBusiness(
  featureLabel?: string,
  options: RequireActiveBusinessOptions = {},
) {
  const { enabled = true } = options;
  const { currentOrg } = useOrganization();
  const { currentBusiness, businesses, isLoading } = useBusinesses();

  // Mirror the SidebarContextSwitcher loading heuristic: BusinessContext
  // flips isLoading=false one tick before currentBusiness is assigned, so a
  // naive check fires the toast during normal hydration. Treat the org →
  // business chain as still loading while businesses exist but none is
  // active yet.
  const isContextLoading =
    isLoading || (!!currentOrg && !currentBusiness && businesses.length > 0);

  useEffect(() => {
    if (!enabled) return;
    if (!currentOrg) return;
    if (isContextLoading) return;
    if (currentBusiness) return;
    if (businesses.length === 0) return;
    toast.error(
      featureLabel
        ? `Select a Company to use ${featureLabel}.`
        : "Select a Company from the workspace switcher to continue.",
      { id: "no-active-business" },
    );
  }, [enabled, currentOrg?.id, currentBusiness?.id, businesses.length, isContextLoading, featureLabel]);

  return {
    ready: !!currentOrg && !!currentBusiness,
    currentOrg,
    currentBusiness,
    needsCompanySelection: !!currentOrg && !isContextLoading && !currentBusiness && businesses.length > 0,
    needsCompanyCreation: !!currentOrg && !isLoading && businesses.length === 0,
  };
}