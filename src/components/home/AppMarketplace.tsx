/**
 * AppMarketplace Component
 * 
 * Dialog for browsing and installing/uninstalling apps.
 * Shows all available apps organized by category.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Package, Lock, Check, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AppCard } from "./AppCard";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useAppSetupStatus } from "@/hooks/useAppSetupStatus";
import { usePlatformApps } from "@/hooks/usePlatformApps";
import { APP_REGISTRY, getAppGroups } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";
import { formatAppPrice } from "@/lib/pricing/formatAppPrice";
import { useCurrencyMap } from "@/hooks/useCurrencyMap";

interface AppMarketplaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppMarketplace({ open, onOpenChange }: AppMarketplaceProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [uninstallApp, setUninstallApp] = useState<AppDefinition | null>(null);
  const navigate = useNavigate();

  const {
    isInstalled,
    canUninstall,
    installApp,
    uninstallApp: doUninstall,
  } = useInstalledApps();
  const { canAccessApp } = useAppNavigation();
  const { getAppEntitlementState, getAppPricing, getAppTrial } = useAppAccess();
  const { getCardSummary } = useAppSetupStatus();
  const { getAction } = useAppLifecycle({
    onNavigate: (path) => {
      onOpenChange(false);
      navigate(path);
    },
    onOpenUpgrade: () => {
      onOpenChange(false);
      navigate("/settings/apps");
    },
  });
  const { data: platformApps } = usePlatformApps();
  const { currencyMap } = useCurrencyMap();
  const appGroups = getAppGroups();

  // Marketplace = single source of truth.
  // - APP_REGISTRY owns UX metadata (icon, color, route map).
  // - platform_apps (DB) owns discoverability via `is_available`.
  // - Coming-soon apps are kept visible (they explain themselves on click);
  //   off-region or admin-disabled apps are filtered out entirely.
  const availableSlugs = new Set((platformApps ?? []).map((a) => a.id));
  const allApps = APP_REGISTRY.filter((app) => {
    if (app.isPlatform) return false;
    if (app.comingSoon) return true; // always show coming-soon tiles
    // While platform_apps is loading, show everything from registry to avoid flicker.
    if (!platformApps) return true;
    return availableSlugs.has(app.id);
  });

  const filteredApps = searchQuery
    ? allApps.filter(app =>
        app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        app.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allApps;

  const installedApps = filteredApps.filter(app => isInstalled(app.id));
  const availableApps = filteredApps.filter(app => !isInstalled(app.id));

  const handleUninstall = async () => {
    if (!uninstallApp) return;
    try {
      await doUninstall(uninstallApp.id);
      setUninstallApp(null);
    } catch (error) {
      console.error("Uninstall error:", error);
    }
  };

  const renderAppGrid = (apps: AppDefinition[], showActions: boolean = true) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {apps.map((app) => {
        const access = canAccessApp(app);
        const installed = isInstalled(app.id);
        const lockedByPermission = !access.hasAccess && access.denialReason === "permission";

        const entitlementState = getAppEntitlementState(app.id);
        const pricing = getAppPricing(app.id);
        const trial = getAppTrial(app.id);
        const trialDaysLeft =
          trial?.expires_at
            ? Math.max(0, Math.ceil((new Date(trial.expires_at).getTime() - Date.now()) / 86_400_000))
            : undefined;
        const addonPriceLabel =
          pricing && pricing.monthly_price && pricing.monthly_price > 0
            ? formatAppPrice(Number(pricing.monthly_price), pricing.currency, { perUser: pricing.is_per_user }, currencyMap)
            : undefined;
        const lifecycleAction = getAction(app);
        const setupRequired = installed ? getCardSummary(app.id) : null;

        return (
          <AppCard
            key={app.id}
            app={app}
            isInstalled={installed}
            isLocked={lockedByPermission && !installed}
            lockReason={lockedByPermission ? "permission" : undefined}
            size="default"
            showActions={showActions}
            canUninstall={canUninstall(app.id)}
            onUninstall={() => setUninstallApp(app)}
            entitlementState={entitlementState}
            addonPriceLabel={addonPriceLabel}
            trialDaysLeft={trialDaysLeft}
            lifecycleAction={lifecycleAction}
            setupRequired={setupRequired}
          />
        );
      })}
    </div>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[85vh] h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              App Marketplace
            </DialogTitle>
            <DialogDescription>
              Install apps to add new functionality to your workspace
            </DialogDescription>
          </DialogHeader>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="all" className="gap-2">
                All
                <Badge variant="secondary" className="text-xs">
                  {filteredApps.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="installed" className="gap-2">
                Installed
                <Badge variant="secondary" className="text-xs">
                  {installedApps.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="available" className="gap-2">
                Available
                <Badge variant="secondary" className="text-xs">
                  {availableApps.length}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <ScrollArea className="flex-1 mt-4 pr-4">
              <TabsContent value="all" className="mt-0 space-y-6">
                {appGroups.map((group) => {
                  const groupApps = filteredApps.filter(app =>
                    group.apps.some(ga => ga.id === app.id)
                  );
                  if (groupApps.length === 0) return null;
                  
                  return (
                    <div key={group.label}>
                      <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                        {group.label}
                        <Badge variant="outline" className="text-xs">
                          {groupApps.filter(a => isInstalled(a.id)).length}/{groupApps.length}
                        </Badge>
                      </h3>
                      {renderAppGrid(groupApps)}
                    </div>
                  );
                })}
              </TabsContent>

              <TabsContent value="installed" className="mt-0">
                {installedApps.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Check className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No installed apps match your search</p>
                  </div>
                ) : (
                  renderAppGrid(installedApps)
                )}
              </TabsContent>

              <TabsContent value="available" className="mt-0">
                {availableApps.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>All available apps are installed!</p>
                  </div>
                ) : (
                  renderAppGrid(availableApps)
                )}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Uninstall Confirmation */}
      <AlertDialog open={!!uninstallApp} onOpenChange={() => setUninstallApp(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {uninstallApp?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the app from your workspace. Your data will be preserved
              and you can reinstall the app anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUninstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
