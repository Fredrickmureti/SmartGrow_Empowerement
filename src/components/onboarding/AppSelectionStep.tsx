/**
 * App Selection Step Component
 * 
 * Allows users to choose which apps to install during signup.
 * Reads available apps from the platform_apps DB table (admin-controlled).
 * Uses APP_REGISTRY for UI metadata (icons, colors).
 * Core apps are pre-selected and required.
 */

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Loader2, Check, Package, Info } from "lucide-react";
import { APP_REGISTRY, getAppById } from "@/lib/apps/registry";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface ClosureRow {
  app_id: string;
  is_root: boolean;
  is_already_installed: boolean;
  is_in_plan: boolean;
  pricing_monthly: number | null;
  pricing_currency: string;
  is_addon_only: boolean;
  depth: number;
}

interface PlatformApp {
  id: string;
  name: string;
  description: string | null;
  category: string;
  required_plan: string;
  is_available: boolean;
  is_core: boolean;
  sort_order: number;
}

interface AppSelectionStepProps {
  selectedApps: string[];
  onSelectedAppsChange: (apps: string[]) => void;
  onBack: () => void;
  onNext: () => void;
  isLoading?: boolean;
}

// Category display labels
const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  operations: "Operations",
  analytics: "Analytics",
  productivity: "Productivity",
  integrations: "Integrations",
};

export function AppSelectionStep({
  selectedApps,
  onSelectedAppsChange,
  onBack,
  onNext,
  isLoading = false,
}: AppSelectionStepProps) {
  const [platformApps, setPlatformApps] = useState<PlatformApp[]>([]);
  const [dbLoading, setDbLoading] = useState(true);

  // Fetch available apps from platform_apps table
  useEffect(() => {
    const fetchApps = async () => {
      try {
        const { data, error } = await supabase
          .from("platform_apps")
          .select("id, name, description, category, required_plan, is_available, is_core, sort_order, is_visible_in_signup")
          .eq("is_available", true)
          .eq("is_visible_in_signup", true)
          .order("sort_order", { ascending: true });

        if (error) {
          console.warn("[AppSelectionStep] Failed to fetch platform_apps, falling back to registry:", error);
          setPlatformApps([]);
        } else {
          setPlatformApps(data || []);
        }
      } catch (err) {
        console.warn("[AppSelectionStep] Error fetching platform_apps:", err);
        setPlatformApps([]);
      } finally {
        setDbLoading(false);
      }
    };
    fetchApps();
  }, []);

  // Group apps by category from DB data
  const appGroups = useMemo(() => {
    // If DB returned apps, use those; otherwise fall back to registry
    if (platformApps.length > 0) {
      const groups: Record<string, PlatformApp[]> = {};
      for (const app of platformApps) {
        if (!groups[app.category]) groups[app.category] = [];
        groups[app.category].push(app);
      }
      // Return in a stable category order
      const categoryOrder = ["core", "operations", "analytics", "productivity", "integrations"];
      return categoryOrder
        .filter(cat => groups[cat]?.length > 0)
        .map(cat => ({
          label: CATEGORY_LABELS[cat] || cat,
          apps: groups[cat],
          isCore: cat === "core",
        }));
    }

    // Fallback: use APP_REGISTRY (hardcoded). Note the legacy `hr` is filtered
    // out and the five split apps (employees / time-off / attendance / payroll /
    // recruitment) take its place under operations.
    const fallbackApps: PlatformApp[] = APP_REGISTRY
      .filter(a => !a.isPlatform && a.id !== "hr")
      .map(a => ({
        id: a.id,
        name: a.name,
        description: a.description || null,
        category: ["finance", "sales", "contacts", "purchases", "inventory"].includes(a.id) ? "core" :
          ["pos", "crm", "employees", "time-off", "attendance", "payroll", "projects", "studio"].includes(a.id) ? "operations" :
          ["reports"].includes(a.id) ? "analytics" : "integrations",
        required_plan: a.requiredPlan || "starter",
        is_available: true,
        is_core: ["finance", "sales", "purchases"].includes(a.id),
        sort_order: a.sortOrder || 0,
      }))
      .filter(a => a.is_available); // hide coming-soon apps from signup

    const groups: Record<string, PlatformApp[]> = {};
    for (const app of fallbackApps) {
      if (!groups[app.category]) groups[app.category] = [];
      groups[app.category].push(app);
    }
    const categoryOrder = ["core", "operations", "analytics", "productivity", "integrations"];
    return categoryOrder
      .filter(cat => groups[cat]?.length > 0)
      .map(cat => ({
        label: CATEGORY_LABELS[cat] || cat,
        apps: groups[cat],
        isCore: cat === "core",
      }));
  }, [platformApps]);

  // Collect all core app IDs from DB
  const coreAppIds = useMemo(() => {
    if (platformApps.length > 0) {
      return platformApps.filter(a => a.is_core).map(a => a.id);
    }
    return ["finance", "sales", "purchases", "platform"];
  }, [platformApps]);

  const toggleApp = (appId: string) => {
    if (coreAppIds.includes(appId)) return;
    const app = platformApps.find(a => a.id === appId);
    if (app && app.is_available === false) return; // coming-soon apps cannot be selected
    if (selectedApps.includes(appId)) {
      onSelectedAppsChange(selectedApps.filter(id => id !== appId));
    } else {
      onSelectedAppsChange([...selectedApps, appId]);
    }
  };

  const isAppSelected = (appId: string) => selectedApps.includes(appId);
  const isCoreApp = (appId: string) => coreAppIds.includes(appId);
  const isComingSoon = (appId: string) => {
    const app = platformApps.find(a => a.id === appId);
    return app ? app.is_available === false : false;
  };

  // Single-institution build: every app in the registry is included, so there
  // is no plan-inclusion / add-on pricing closure to preview here.


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
          <Check className="w-6 h-6 text-primary" />
        </div>
        <h3 className="font-semibold text-lg">Choose your apps</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Select the apps you need. You can add more anytime from Settings.
        </p>
      </div>

      {/* App Groups */}
      {dbLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-5 max-h-[340px] overflow-y-auto pr-1">
          {appGroups.map((group) => (
            <div key={group.label} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
                {group.isCore && (
                  <span className="ml-2 text-primary font-normal normal-case">(Required)</span>
                )}
              </h4>
              
              <div className="grid grid-cols-2 gap-2">
                {group.apps.map((app) => {
                  const selected = isAppSelected(app.id);
                  const core = isCoreApp(app.id);
                  // Get icon/color from client-side registry for UI rendering
                  const registryApp = getAppById(app.id);
                  const Icon = registryApp?.icon || Package;
                  const color = registryApp?.color;

                  return (
                    <button
                      key={app.id}
                      type="button"
                      onClick={() => toggleApp(app.id)}
                      disabled={core}
                      className={cn(
                        "relative flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
                        selected || core
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/50",
                        core && "cursor-default opacity-90"
                      )}
                    >
                      {/* Checkbox indicator */}
                      <div
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                          selected || core
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-muted-foreground/30"
                        )}
                      >
                        {(selected || core) && <Check className="h-3.5 w-3.5" />}
                      </div>

                      {/* App icon and name */}
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon 
                          className="h-4 w-4 shrink-0" 
                          style={color ? { color } : undefined}
                        />
                        <span className="text-sm font-medium truncate">{app.name}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}




      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        You can add or remove apps anytime from Settings.
      </p>

      {/* Navigation buttons */}
      <div className="flex gap-3">
        <Button 
          type="button" 
          variant="outline" 
          className="flex-1 h-11" 
          onClick={onBack}
          disabled={isLoading}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button 
          type="button" 
          className="flex-1 h-11" 
          onClick={onNext}
          disabled={isLoading || dbLoading}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading...
            </>
          ) : (
            <>
              Continue
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Get default selected apps for new signups.
 * Includes core apps + common useful defaults.
 * Note: "platform" is always installed but hidden from selection UI.
 * 
 * For DB-driven defaults during signup, the AppSelectionStep component
 * derives defaults from platform_apps data directly. This function
 * serves as a static fallback when DB data is unavailable.
 */
export function getDefaultSelectedApps(): string[] {
  return [
    "finance", "sales", "contacts", "purchases", "platform",
    "inventory", "reports",
  ];
}
