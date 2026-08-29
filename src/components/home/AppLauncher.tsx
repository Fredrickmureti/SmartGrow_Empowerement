/**
 * AppLauncher Component
 * 
 * Odoo-style app grid for the home dashboard.
 * Shows installed apps and allows quick navigation.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, LayoutGrid, List, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AppTileCard } from "@/components/apps/AppTileCard";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { APP_REGISTRY, getAppGroups } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

interface AppLauncherProps {
  className?: string;
  showSearch?: boolean;
  showMarketplaceButton?: boolean;
  variant?: "grid" | "compact";
}

export function AppLauncher({
  className,
  showSearch = true,
  showMarketplaceButton = true,
  variant = "grid",
}: AppLauncherProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- decoration: skeleton inside launcher card, not an install gate
  const { installedApps, isInstalled, isLoading } = useInstalledApps();
  const { canAccessApp, getAppUrl, currentApp } = useAppNavigation();
  const appGroups = getAppGroups();

  // Get installed apps with access info — hide apps the user cannot access (Odoo-aligned)
  const installedAppsWithAccess = APP_REGISTRY.filter(app => isInstalled(app.id))
    .map(app => ({
      app,
      access: canAccessApp(app),
    }))
    .filter(({ access }) => access.hasAccess)
    .sort((a, b) => (a.app.sortOrder || 0) - (b.app.sortOrder || 0));

  // Filter by search
  const filteredApps = searchQuery
    ? installedAppsWithAccess.filter(({ app }) =>
        app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        app.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : installedAppsWithAccess;

  // Group apps for display
  const groupedApps = appGroups
    .map(group => ({
      ...group,
      apps: group.apps.filter(app => 
        filteredApps.some(({ app: fa }) => fa.id === app.id)
      ),
    }))
    .filter(group => group.apps.length > 0);

  const handleAppSelect = (app: AppDefinition) => {
    const url = getAppUrl(app);
    navigate(url);
  };

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <div className="animate-pulse text-muted-foreground">Loading apps...</div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4 sm:space-y-6", className)}>
      {/* Header */}
      <div className="flex flex-col @[44rem]/page:flex-row @[44rem]/page:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Your Apps</h1>
          <p className="text-sm text-muted-foreground">
            {installedAppsWithAccess.length} modules available
          </p>
        </div>
        
        <div className="flex flex-col @[30rem]/page:flex-row items-stretch @[30rem]/page:items-center gap-2 w-full @[44rem]/page:w-auto">
          {showSearch && (
            <div className="relative w-full @[44rem]/page:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search apps..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          )}
          
          <div className="flex items-center gap-2">
            <div className="flex items-center border rounded-lg p-1">
              <Button
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setViewMode("grid")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setViewMode("list")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Apps Grid */}
      {filteredApps.length === 0 ? (
        <div className="text-center py-12 border rounded-xl bg-muted/20">
          {searchQuery ? (
            <>
              <Search className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium">No apps found</h3>
              <p className="text-muted-foreground mt-1">
                Try a different search term
              </p>
            </>
          ) : (
            <>
              <Sparkles className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium">No modules available</h3>
              <p className="text-muted-foreground mt-1 mb-4">
                Your role does not grant access to any module yet. Contact a Super Administrator.
              </p>
            </>
          )}
        </div>
      ) : viewMode === "grid" ? (
        <div className="space-y-4 sm:space-y-8">
          {groupedApps.map((group) => (
            <div key={group.label}>
              <h2 className="text-xs sm:text-sm font-medium text-muted-foreground mb-2 sm:mb-3 flex items-center gap-2">
                {group.label}
                <Badge variant="secondary" className="text-xs">
                  {group.apps.length}
                </Badge>
              </h2>
              <div className="grid grid-cols-1 @[22rem]/page:grid-cols-2 @[36rem]/page:grid-cols-3 @[48rem]/page:grid-cols-4 @[62rem]/page:grid-cols-5 gap-2 sm:gap-3">
                {group.apps.map((app) => {
                  const access = canAccessApp(app);
                  return (
                    <AppTileCard
                      key={app.id}
                      app={app}
                      isInstalled={true}
                      onOpen={() => handleAppSelect(app)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredApps.map(({ app }) => (
            <AppTileCard
              key={app.id}
              app={app}
              isInstalled={true}
              onOpen={() => handleAppSelect(app)}
              size="small"
            />
          ))}
        </div>
      )}
    </div>
  );
}
