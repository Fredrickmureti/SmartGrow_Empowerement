import { normalizeError } from "@/services/resilience";
// @ts-nocheck - Admin tables not in auto-generated types
/**
 * Plan App Access Settings
 * 
 * Simplified app-level access management for Platform Admin.
 * Controls which apps are available per subscription plan (Odoo-style).
 */
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, LayoutGrid } from "lucide-react";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { APP_REGISTRY, getAppGroups } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

interface SubscriptionPlan {
  id: string;
  name: string;
  price_monthly: number;
}

interface AppAccess {
  id: string;
  plan_id: string;
  app_id: string;
  is_enabled: boolean;
}

// Apps that should be shown in this settings panel (excludes platform)
const MANAGEABLE_APPS = APP_REGISTRY.filter(app => !app.isPlatform);

// Group apps for display
const APP_GROUPS = getAppGroups().filter(g => g.label !== "Platform");

export function PlanAppAccessSettings() {
  const { toast } = useToast();
  const { formatCurrency } = useAdminCurrency();
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [appAccess, setAppAccess] = useState<Record<string, AppAccess[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      // Fetch plans
      const { data: plansData, error: plansError } = await (supabase.from as any)("platform_subscription_plans")
        .select("id, name, price_monthly")
        .eq("is_active", true)
        .order("price_monthly") as { data: any[] | null; error: any };

      if (plansError) throw plansError;

      setPlans(plansData || []);
      if (plansData && plansData.length > 0 && !selectedPlanId) {
        setSelectedPlanId(plansData[0].id);
      }

      // Fetch all app access settings
      const { data: accessData, error: accessError } = await (supabase.from as any)("plan_app_access")
        .select("*") as { data: any[] | null; error: any };

      if (accessError) throw accessError;

      // Group by plan_id
      const grouped: Record<string, AppAccess[]> = {};
      (accessData || []).forEach((a) => {
        if (!grouped[a.plan_id]) grouped[a.plan_id] = [];
        grouped[a.plan_id].push(a);
      });
      setAppAccess(grouped);
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getAppAccess = (planId: string, appId: string): AppAccess | undefined => {
    return appAccess[planId]?.find((a) => a.app_id === appId);
  };

  const isAppEnabled = (planId: string, appId: string): boolean => {
    const access = getAppAccess(planId, appId);
    return access?.is_enabled ?? false;
  };

  const updateAppAccess = (planId: string, appId: string, isEnabled: boolean) => {
    setHasChanges(true);
    setAppAccess((prev) => {
      const existing = prev[planId] || [];
      const accessIndex = existing.findIndex((a) => a.app_id === appId);

      if (accessIndex >= 0) {
        const updated = [...existing];
        updated[accessIndex] = { ...updated[accessIndex], is_enabled: isEnabled };
        return { ...prev, [planId]: updated };
      } else {
        // Create new access entry
        return {
          ...prev,
          [planId]: [
            ...existing,
            {
              id: `new-${Date.now()}-${appId}`,
              plan_id: planId,
              app_id: appId,
              is_enabled: isEnabled,
            },
          ],
        };
      }
    });
  };

  const handleEnableAll = (planId: string) => {
    setHasChanges(true);
    MANAGEABLE_APPS.forEach(app => {
      updateAppAccess(planId, app.id, true);
    });
  };

  const handleEnableCoreOnly = (planId: string) => {
    setHasChanges(true);
    const coreAppIds = ["finance", "sales", "purchases", "inventory", "reports"];
    MANAGEABLE_APPS.forEach(app => {
      updateAppAccess(planId, app.id, coreAppIds.includes(app.id));
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const accessEntries = appAccess[selectedPlanId] || [];

      // Use upsert to handle both new and existing records
      const upsertData = accessEntries.map(access => ({
        plan_id: access.plan_id,
        app_id: access.app_id,
        is_enabled: access.is_enabled,
        updated_at: new Date().toISOString(),
      }));

      if (upsertData.length > 0) {
        const { error } = await (supabase.from as any)("plan_app_access")
          .upsert(upsertData, {
            onConflict: 'plan_id,app_id',
            ignoreDuplicates: false 
          });
        
        if (error) throw error;
      }

      toast({
        title: "App access saved",
        description: "Plan app access has been updated successfully.",
      });

      setHasChanges(false);
      await fetchData();
    } catch (error: any) {
      console.error("Save error:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to save app access",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const selectedPlan = plans.find((p) => p.id === selectedPlanId);

  // Count enabled apps
  const enabledCount = MANAGEABLE_APPS.filter(app => isAppEnabled(selectedPlanId, app.id)).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <LayoutGrid className="h-5 w-5" />
              App Access by Plan
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Configure which apps are available for each subscription plan.
              <br className="hidden sm:block" />
              <span className="text-xs text-muted-foreground">
                This is the primary access gate. Feature toggles provide granular control within apps.
              </span>
            </CardDescription>
          </div>
          {hasChanges && (
            <Button onClick={handleSave} disabled={isSaving} className="w-full sm:w-auto">
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save Changes
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0">
        <Tabs value={selectedPlanId} onValueChange={setSelectedPlanId}>
          <div className="overflow-x-auto scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0 mb-6">
            <TabsList className="inline-flex w-max sm:w-auto">
              {plans.map((plan) => (
                <TabsTrigger key={plan.id} value={plan.id} className="text-xs sm:text-sm whitespace-nowrap">
                  {plan.name}
                  <Badge variant="secondary" className="ml-1.5 sm:ml-2 text-[10px] sm:text-xs hidden xs:inline-flex">
                    {formatCurrency(plan.price_monthly)}/mo
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {plans.map((plan) => (
              <TabsContent key={plan.id} value={plan.id} className="space-y-6">
                {/* Plan Summary */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-3 sm:p-4 rounded-lg bg-muted/50">
                  <div>
                    <div className="font-medium text-sm sm:text-base">{plan.name} Plan</div>
                    <div className="text-xs sm:text-sm text-muted-foreground">
                      {enabledCount} of {MANAGEABLE_APPS.length} apps enabled
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-none text-xs sm:text-sm"
                      onClick={() => handleEnableCoreOnly(plan.id)}
                    >
                      Core Only
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-none text-xs sm:text-sm"
                      onClick={() => handleEnableAll(plan.id)}
                    >
                      Enable All
                    </Button>
                  </div>
                </div>

                {/* App Groups */}
                {APP_GROUPS.map((group) => (
                  <div key={group.label} className="space-y-3">
                    <h4 className="font-medium text-xs sm:text-sm text-muted-foreground uppercase tracking-wide">
                      {group.label}
                    </h4>
                    <div className="grid gap-2 sm:gap-3 md:grid-cols-2">
                      {group.apps.map((app) => (
                        <AppAccessCard
                          key={app.id}
                          app={app}
                          isEnabled={isAppEnabled(plan.id, app.id)}
                          isLocked={false}
                          onToggle={(enabled) => updateAppAccess(plan.id, app.id, enabled)}
                        />
                      ))}
                    </div>
                    <Separator className="my-4" />
                  </div>
                ))}
              </TabsContent>
            ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

interface AppAccessCardProps {
  app: AppDefinition;
  isEnabled: boolean;
  isLocked: boolean;
  onToggle: (enabled: boolean) => void;
}

function AppAccessCard({ app, isEnabled, isLocked, onToggle }: AppAccessCardProps) {
  const Icon = app.icon;
  
  return (
    <div
      className={`flex items-center justify-between p-3 sm:p-4 rounded-lg border bg-card transition-colors ${
        isEnabled ? "border-primary/30 bg-primary/5" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <div
          className="flex h-8 w-8 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${app.color}20` }}
        >
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" style={{ color: app.color }} />
        </div>
        <div className="min-w-0">
          <div className="font-medium text-xs sm:text-sm">{app.name}</div>
          <div className="text-[11px] sm:text-xs text-muted-foreground line-clamp-1">
            {app.description}
          </div>
        </div>
      </div>
      
      <Switch
        checked={isEnabled}
        onCheckedChange={onToggle}
        disabled={isLocked}
        className="shrink-0 ml-2"
      />
    </div>
  );
}
