/**
 * Apps Marketplace Page
 * 
 * Odoo-style dedicated /apps route with:
 * - "Your Apps" section showing installed apps
 * - "Discover More" section for available apps
 * - Clean marketplace tile grid layout
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Search, Grid3X3, LayoutList, Bell } from "lucide-react";
import { PlatformAppLayout } from "@/apps/platform";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppTileCard } from "@/components/apps/AppTileCard";
import { InstallAppDialog } from "@/components/apps/InstallAppDialog";
import { UninstallAppDialog } from "@/components/apps/UninstallAppDialog";
import { Button } from "@/components/ui/button";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useSession } from "@/contexts/SessionContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { APP_REGISTRY, getAppGroups } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";
import { formatAppPrice } from "@/lib/pricing/formatAppPrice";
import { useCurrencyMap } from "@/hooks/useCurrencyMap";

export default function Apps() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- decoration: page-level skeleton, not an install gate
  const { isInstalled, installApp, uninstallApp, isLoading: isLoadingApps } = useInstalledApps();
  const { isLoading: isSessionLoading, currentOrg } = useSession();
  const [installDialogApp, setInstallDialogApp] = useState<AppDefinition | null>(null);
  const [uninstallDialogApp, setUninstallDialogApp] = useState<AppDefinition | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const { getAppEntitlementState, getAppPricing, getAppTrial } = useAppAccess();
  const { currencyMap } = useCurrencyMap();
  const lifecycle = useAppLifecycle({
    onOpenUpgrade: (appId) => navigate(`/apps/${appId}/activate`),
    onNavigate: (path) => navigate(path),
  });

  // Filter apps based on search
  const filteredApps = APP_REGISTRY.filter(app => {
    if (app.isPlatform) return false; // Don't show platform/settings in marketplace
    const query = searchQuery.toLowerCase();
    return (
      app.name.toLowerCase().includes(query) ||
      app.description.toLowerCase().includes(query)
    );
  });

  // Split into installed and available
  const installedApps = filteredApps.filter(app => isInstalled(app.id));
  const availableApps = filteredApps.filter(app => !isInstalled(app.id));

  const getTileMeta = (app: AppDefinition) => {
    const entitlementState = getAppEntitlementState(app.id);
    const pricing = getAppPricing(app.id);
    const trial = getAppTrial(app.id);
    const trialDaysLeft = trial?.expires_at
      ? Math.max(0, Math.ceil((new Date(trial.expires_at).getTime() - Date.now()) / 86_400_000))
      : undefined;

    // Entitlement-aware label (Odoo psychology):
    //   in_plan        → "Included"             (no $ — already paid for)
    //   trial          → "Trial — N days left"  (urgency, no $ shown yet)
    //   expired_trial  → "Subscribe — {price}"  (clear next step + cost)
    //   addon (paid)   → "Add-on — {price}"     (transparent add-on cost)
    //   addon (free)   → "Free add-on"          (honest about $0)
    //   coming_soon    → handled separately by isAppLocked/getLockedLabel
    const priceText = pricing?.monthly_price && Number(pricing.monthly_price) > 0
      ? formatAppPrice(Number(pricing.monthly_price), pricing.currency, { perUser: pricing.is_per_user }, currencyMap)
      : null;

    let addonPriceLabel: string | undefined;
    switch (entitlementState) {
      case "in_plan":
      case "overridden":
        addonPriceLabel = "Included";
        break;
      case "trial":
        addonPriceLabel = trialDaysLeft != null
          ? `Trial — ${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left`
          : "Trial";
        break;
      case "expired_trial":
        addonPriceLabel = priceText ? `Subscribe — ${priceText}` : "Subscribe";
        break;
      case "addon":
        addonPriceLabel = priceText ? `Add-on — ${priceText}` : "Free add-on";
        break;
      default:
        addonPriceLabel = priceText ?? undefined;
    }

    return { entitlementState, addonPriceLabel, trialDaysLeft };
  };

  // Marketplace discovery is not plan-blurred. Apps are installable/discoverable
  // unless they are explicitly not shippable yet; entitlement is enforced by DB RPC.
  const isAppLocked = (app: AppDefinition) => {
    if (isSessionLoading) return false;
    return !!app.comingSoon;
  };

  const getLockedLabel = (app: AppDefinition): string | undefined => {
    if (!isAppLocked(app)) return undefined;
    return app.comingSoon ? "Coming soon" : undefined;
  };
  
  const isLoading = isLoadingApps || isSessionLoading;

  const addOnCount = filteredApps.filter(app => getAppEntitlementState(app.id) === "addon").length;

  const handleInstallClick = (app: AppDefinition) => {
    if (isAppLocked(app)) return;
    // Coming soon / locked apps still route to landing for context
    if (app.comingSoon) {
      navigate(`/apps/${app.id}/activate`);
      return;
    }
    // Open the dependency-aware preflight dialog
    setInstallDialogApp(app);
  };

  const handleConfirmInstall = async () => {
    if (!installDialogApp) return;
    setIsMutating(true);
    try {
      await installApp(installDialogApp.id);
      const defaultModule = installDialogApp.defaultModule
        ? installDialogApp.modules.find((m) => m.id === installDialogApp.defaultModule)
        : installDialogApp.modules[0];
      const path = `${installDialogApp.basePath}${defaultModule?.path || ""}`;
      setInstallDialogApp(null);
      navigate(path);
    } catch {
      // useInstalledApps surfaces a structured toast already
    } finally {
      setIsMutating(false);
    }
  };

  const handleConfirmUninstall = async () => {
    if (!uninstallDialogApp) return;
    setIsMutating(true);
    try {
      await uninstallApp(uninstallDialogApp.id);
      setUninstallDialogApp(null);
    } catch {
      // toast handled in hook
    } finally {
      setIsMutating(false);
    }
  };

  // Notify-me is now handled by the unified AppUnderDevelopment page reached
  // via /apps/{appId}/activate (single source of truth: app_launch_notifications).
  // Coming-soon tiles route there instead of firing a separate RPC here.
  const appGroups = getAppGroups();

  // Animation variants
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <PlatformAppLayout>
      <div className="container max-w-7xl mx-auto px-3 sm:px-4 md:px-6 py-4 md:py-8 space-y-4 md:space-y-8">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Apps</h1>
            <p className="text-muted-foreground mt-1">
              Install and manage your business applications
              {currentOrg?.plan && (
                <span className="text-xs ml-2 text-primary">
                  • {currentOrg.plan.name} Plan
                </span>
              )}
            </p>
            {!isLoading && currentOrg && addOnCount > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {addOnCount} app(s) are available as add-ons for “{currentOrg.name}”.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search apps..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* View toggle */}
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "grid" | "list")}>
              <TabsList className="h-9">
                <TabsTrigger value="grid" className="px-2.5">
                  <Grid3X3 className="h-4 w-4" />
                </TabsTrigger>
                <TabsTrigger value="list" className="px-2.5">
                  <LayoutList className="h-4 w-4" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {/* Loading Skeleton */}
        {isLoading && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="h-7 w-32 rounded-md bg-muted animate-pulse" />
              <div className="h-5 w-20 rounded-md bg-muted animate-pulse" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="rounded-xl bg-muted animate-pulse h-[140px]" />
              ))}
            </div>
          </section>
        )}

        {/* Your Apps Section */}
        {!isLoading && installedApps.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Your Apps</h2>
              <span className="text-sm text-muted-foreground">
                {installedApps.length} installed
              </span>
            </div>

            <motion.div
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              className={
                viewMode === "grid"
                  ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4"
                  : "flex flex-col gap-2"
              }
            >
              {installedApps.map((app) => {
                const meta = getTileMeta(app);
                return <motion.div key={app.id} variants={itemVariants}>
                  <AppTileCard
                    app={app}
                    isInstalled={true}
                    isLocked={isAppLocked(app)}
                    lockedLabel={getLockedLabel(app)}
                    size={viewMode === "grid" ? "medium" : "small"}
                    showDescription={viewMode === "grid"}
                    {...meta}
                  />
                </motion.div>;
              })}
            </motion.div>
          </section>
        )}

        {/* Discover More Section */}
        {!isLoading && availableApps.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Discover More</h2>
              <span className="text-sm text-muted-foreground">
                {availableApps.length} available
              </span>
            </div>

            <motion.div
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              className={
                viewMode === "grid"
                  ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4"
                  : "flex flex-col gap-2"
              }
            >
              {availableApps.map((app) => {
                const meta = getTileMeta(app);
                const action = lifecycle.getAction(app);
                const comingSoon = !!app.comingSoon;
                return <motion.div key={app.id} variants={itemVariants} className="flex flex-col gap-2">
                  <AppTileCard
                    app={app}
                    isInstalled={false}
                    isLocked={isAppLocked(app)}
                    lockedLabel={getLockedLabel(app)}
                    onInstall={() => handleInstallClick(app)}
                    size={viewMode === "grid" ? "medium" : "small"}
                    showDescription={viewMode === "grid"}
                    lifecycleAction={action}
                    {...meta}
                  />
                  {/* Coming-soon apps route to /apps/{id}/activate which renders
                      the AppUnderDevelopment page with the unified notify-me flow. */}
                </motion.div>;
              })}
            </motion.div>
          </section>
        )}

        {/* Empty state */}
        {!isLoading && filteredApps.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
              <Search className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No apps found</h3>
            <p className="text-muted-foreground mt-1">
              Try adjusting your search query
            </p>
          </div>
        )}

        {/* App Categories - Grouped View */}
        {!isLoading && !searchQuery && (
          <section className="pt-8 border-t">
            <h2 className="text-xl font-semibold mb-6">Browse by Category</h2>
            <div className="space-y-8">
              {appGroups.filter(g => g.label !== "Platform").map((group) => (
                <div key={group.label}>
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                    {group.apps.map((app) => {
                      const meta = getTileMeta(app);
                      const installed = isInstalled(app.id);
                      const action = !installed && !app.comingSoon ? lifecycle.getAction(app) : undefined;
                      return (
                      <AppTileCard
                        key={app.id}
                        app={app}
                        isInstalled={installed}
                        isLocked={isAppLocked(app)}
                        lockedLabel={getLockedLabel(app)}
                        onInstall={() => handleInstallClick(app)}
                        size="small"
                        showDescription={false}
                        lifecycleAction={action}
                        {...meta}
                      />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Dependency-aware install preflight dialog */}
      <InstallAppDialog
        appId={installDialogApp?.id ?? null}
        open={!!installDialogApp}
        onOpenChange={(o) => !o && setInstallDialogApp(null)}
        onConfirm={handleConfirmInstall}
        isInstalling={isMutating}
      />

      {/* Uninstall safety dialog with reverse-dependency check */}
      <UninstallAppDialog
        appId={uninstallDialogApp?.id ?? null}
        appName={uninstallDialogApp?.name ?? ""}
        open={!!uninstallDialogApp}
        onOpenChange={(o) => !o && setUninstallDialogApp(null)}
        onConfirm={handleConfirmUninstall}
        isUninstalling={isMutating}
      />
    </PlatformAppLayout>
  );
}
