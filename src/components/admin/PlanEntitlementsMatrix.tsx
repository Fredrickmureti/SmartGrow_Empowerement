// @ts-nocheck - Admin tables not in auto-generated types
import React, { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { Loader2, Save, LayoutGrid } from "lucide-react";
import { APP_REGISTRY } from "@/lib/apps/registry";
import { normalizeError } from "@/services/resilience";

interface Plan {
  id: string;
  name: string;
  price_monthly: number;
  sort_order: number;
}

interface AppAccess {
  id: string;
  plan_id: string;
  app_id: string;
  is_enabled: boolean;
}

const MANAGEABLE_APPS = APP_REGISTRY.filter(app => !app.isPlatform);

/**
 * App Packaging Matrix
 * 
 * Manages which apps each plan includes. This is the PRIMARY commercial gate.
 * If you have the app, you get ALL pages within it (Odoo model).
 */
export function PlanEntitlementsMatrix() {
  const { toast } = useToast();
  const { formatCurrency } = useAdminCurrency();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [appAccess, setAppAccess] = useState<AppAccess[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function load() {
      const [plansRes, appsRes] = await Promise.all([
        supabase.from("platform_subscription_plans").select("id, name, price_monthly, sort_order").eq("is_active", true).order("sort_order"),
        supabase.from("plan_app_access").select("*"),
      ]);
      setPlans((plansRes.data || []) as Plan[]);
      setAppAccess((appsRes.data || []) as AppAccess[]);
      setIsLoading(false);
    }
    load();
  }, []);

  const getAppEnabled = useCallback((planId: string, appId: string) => {
    const key = `${planId}:${appId}`;
    if (key in pendingChanges) return pendingChanges[key];
    const found = appAccess.find(a => a.plan_id === planId && a.app_id === appId);
    return found?.is_enabled ?? false;
  }, [appAccess, pendingChanges]);

  const toggleApp = (planId: string, appId: string) => {
    const current = getAppEnabled(planId, appId);
    setPendingChanges(prev => ({ ...prev, [`${planId}:${appId}`]: !current }));
    setHasChanges(true);
  };

  const saveAll = async () => {
    setIsSaving(true);
    try {
      for (const [key, enabled] of Object.entries(pendingChanges)) {
        const [planId, appId] = key.split(':');
        const existing = appAccess.find(a => a.plan_id === planId && a.app_id === appId);
        if (existing) {
          await supabase.from("plan_app_access").update({ is_enabled: enabled }).eq("id", existing.id);
        } else {
          await supabase.from("plan_app_access").insert({ plan_id: planId, app_id: appId, is_enabled: enabled });
        }
      }

      const { data } = await supabase.from("plan_app_access").select("*");
      setAppAccess((data || []) as AppAccess[]);
      setPendingChanges({});
      setHasChanges(false);
      toast({ title: "App packaging saved", description: "All plan app access has been updated." });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message || "Failed to save", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <LayoutGrid className="h-5 w-5 text-primary" />
            App Packaging
          </CardTitle>
          <CardDescription>
            Control which apps each plan includes. If an app is enabled, users get all pages within it.
          </CardDescription>
        </div>
        {hasChanges && (
          <Button onClick={saveAll} disabled={isSaving} size="sm">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Save Changes
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b-2 border-border">
                <th className="text-left py-3 px-3 font-medium text-muted-foreground min-w-[200px]">
                  App
                </th>
                {plans.map(plan => (
                  <th key={plan.id} className="text-center py-3 px-4 min-w-[120px]">
                    <div className="font-semibold">{plan.name}</div>
                    <div className="text-xs text-muted-foreground font-normal">
                      {plan.price_monthly === 0 ? 'Free' : `${formatCurrency(plan.price_monthly)}/mo`}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MANAGEABLE_APPS.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(app => (
                <tr key={app.id} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: `${app.color}15` }}>
                        <app.icon className="h-4 w-4" style={{ color: app.color }} />
                      </div>
                      <div>
                        <span className="font-medium">{app.name}</span>
                        <div className="text-xs text-muted-foreground">{app.modules.length} modules</div>
                      </div>
                    </div>
                  </td>
                  {plans.map(plan => {
                    const enabled = getAppEnabled(plan.id, app.id);
                    const isPending = `${plan.id}:${app.id}` in pendingChanges;
                    return (
                      <td key={plan.id} className="text-center py-2.5 px-4">
                        <div className="flex justify-center">
                          <Switch
                            checked={enabled}
                            onCheckedChange={() => toggleApp(plan.id, app.id)}
                            className={isPending ? "ring-2 ring-primary ring-offset-1" : ""}
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
