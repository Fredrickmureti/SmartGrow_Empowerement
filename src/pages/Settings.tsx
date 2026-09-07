/**
 * Settings hub landing page (/settings).
 *
 * Phase 3 of the Zero-Trust audit split the old 17-tab monolith into two
 * scope-aware hubs:
 *   - /settings/workspace  → workspace chrome (profile, security, …)
 *   - /settings/company    → company books (currency, tax, payments, …)
 *
 * The legacy `/settings?tab=<x>` URLs are still common across the codebase
 * (notification deep-links, dashboard buttons, docs, etc.). This wrapper
 * preserves them by mapping each known tab to the new hub it now lives in
 * and redirecting in place — so no link breaks.
 */
import { useEffect } from "react";
import { useSearchParams, useNavigate, Navigate } from "react-router-dom";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { PlatformAppLayout } from "@/apps/platform";
import { useSession } from "@/contexts/SessionContext";

// Tabs that live on the workspace hub.
const WORKSPACE_TABS = new Set([
  "profile",
  "appearance",
  "workspace",
  "organization",       // legacy alias for "workspace"
  "notifications",
  "security",
  "access-groups",
  "governance",
]);

// Tabs that live on the company hub.
const COMPANY_TABS = new Set([
  "company",
  "businesses",         // legacy alias for "company"
  "companies",          // legacy alias for "company"
  "branches",           // lives under the "company" tab (Companies & Branches)
  "currency",
  "payments",
  "payment-gateways",   // legacy alias for "payments"
  "payment-methods",
  "email",
  "templates",
  "printing",
]);

// Aliases that live on dedicated pages outside the two settings hubs.
// We redirect them rather than render a missing tab.
const EXTERNAL_REDIRECTS: Record<string, string> = {
  accounting: "/finance/settings",   // Default GL accounts, fiscal periods, etc.
  defaults: "/finance/settings",     // Legacy alias used by the missing-system-account banner
};

export default function Settings() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = searchParams.get("tab");
  const returnTo = searchParams.get("returnTo");
  const { userType, isLoading: sessionLoading } = useSession();

  // Portal users never see the business Settings hub. Bounce them to the
  // purpose-built `/me/settings` self-service surface, preserving any
  // returnTo they may have come in with.
  if (!sessionLoading && userType === "portal") {
    const dest = returnTo
      ? `/me/settings?returnTo=${encodeURIComponent(returnTo)}`
      : "/me/settings";
    return <Navigate to={dest} replace />;
  }

  useEffect(() => {
    if (!tab) return;
    const params = new URLSearchParams();
    if (returnTo) params.set("returnTo", returnTo);

    // Tabs that have moved out of /settings entirely.
    if (EXTERNAL_REDIRECTS[tab]) {
      navigate(EXTERNAL_REDIRECTS[tab], { replace: true });
      return;
    }

    // Normalize legacy tab names to their new canonical IDs.
    const normalized =
      tab === "organization" ? "workspace" :
      tab === "businesses" || tab === "companies" ? "company" :
      tab === "branches" ? "company" :
      tab === "payment-gateways" ? "payments" :
      tab;

    if (WORKSPACE_TABS.has(tab)) {
      params.set("tab", normalized);
      navigate(`/settings/workspace?${params.toString()}`, { replace: true });
    } else if (COMPANY_TABS.has(tab)) {
      params.set("tab", normalized);
      navigate(`/settings/company?${params.toString()}`, { replace: true });
    } else {
      // Unknown tab → land on workspace hub instead of staying on a blank loader.
      navigate(`/settings/workspace`, { replace: true });
    }
  }, [tab, returnTo, navigate]);

  // No tab requested → land on workspace hub by default.
  if (!tab) {
    return <Navigate to="/settings/workspace" replace />;
  }

  return (
    <PlatformAppLayout>
      <BrandedLoader message="Loading settings..." fullScreen={false} />
    </PlatformAppLayout>
  );
}
