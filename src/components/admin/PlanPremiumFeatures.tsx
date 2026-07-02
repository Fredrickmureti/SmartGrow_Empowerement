// @ts-nocheck - Admin tables not in auto-generated types
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { Loader2, Save, Sparkles } from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface Plan {
  id: string;
  name: string;
  price_monthly: number;
  sort_order: number;
}

interface FeatureAccess {
  id: string;
  plan_id: string;
  feature_key: string;
  is_enabled: boolean;
  limit_value: number | null;
}

interface CatalogFeature {
  feature_key: string;
  label: string;
  description: string | null;
  category: string;
  sort_order: number;
}

export function PlanPremiumFeatures() {
  const { toast } = useToast();
  const { formatCurrency } = useAdminCurrency();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [featureAccess, setFeatureAccess] = useState<FeatureAccess[]>([]);
  const [featureCatalog, setFeatureCatalog] = useState<CatalogFeature[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function load() {
      const [plansRes, featuresRes, catalogRes] = await Promise.all([
        supabase.from("platform_subscription_plans").select("id, name, price_monthly, sort_order").eq("is_active", true).order("sort_order"),
        supabase.from("plan_feature_access").select("*"),
        (supabase as any).from("platform_feature_catalog").select("*").eq("is_active", true).order("sort_order"),
      ]);
      setPlans((plansRes.data || []) as Plan[]);
      setFeatureAccess((featuresRes.data || []) as FeatureAccess[]);
      setFeatureCatalog((catalogRes.data || []) as CatalogFeature[]);
      setIsLoading(false);
    }
    load();
  }, []);

  const getEnabled = useCallback((planId: string, featureKey: string) => {
    const key = `${planId}:${featureKey}`;
    if (key in pendingChanges) return pendingChanges[key];
    const found = featureAccess.find(f => f.plan_id === planId && f.feature_key === featureKey);
    return found?.is_enabled ?? false;
  }, [featureAccess, pendingChanges]);

  const toggle = (planId: string, featureKey: string) => {
    const current = getEnabled(planId, featureKey);
    setPendingChanges(prev => ({ ...prev, [`${planId}:${featureKey}`]: !current }));
    setHasChanges(true);
  };

  const saveAll = async () => {
    setIsSaving(true);
    try {
      for (const [key, enabled] of Object.entries(pendingChanges)) {
        const [planId, featureKey] = key.split(':');
        const existing = featureAccess.find(f => f.plan_id === planId && f.feature_key === featureKey);
        if (existing) {
          await supabase.from("plan_feature_access").update({ is_enabled: enabled }).eq("id", existing.id);
        } else {
          await supabase.from("plan_feature_access").insert({ plan_id: planId, feature_key: featureKey, is_enabled: enabled });
        }
      }

      const { data } = await supabase.from("plan_feature_access").select("*");
      setFeatureAccess((data || []) as FeatureAccess[]);
      setPendingChanges({});
      setHasChanges(false);
      toast({ title: "Premium features saved", description: "Changes applied to all plans." });
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
            <Sparkles className="h-5 w-5 text-primary" />
            Premium Features
          </CardTitle>
          <CardDescription>
            Cross-cutting capabilities that differentiate plan tiers. These are real platform features — not app-level access.
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
                <th className="text-left py-3 px-3 font-medium text-muted-foreground min-w-[240px]">
                  Feature
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
              {featureCatalog.map(feat => (
                <tr key={feat.feature_key} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-3">
                    <div className="font-medium">{feat.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{feat.description}</div>
                  </td>
                  {plans.map(plan => {
                    const enabled = getEnabled(plan.id, feat.feature_key);
                    const isPending = `${plan.id}:${feat.feature_key}` in pendingChanges;
                    return (
                      <td key={plan.id} className="text-center py-3 px-4">
                        <div className="flex justify-center">
                          <Switch
                            checked={enabled}
                            onCheckedChange={() => toggle(plan.id, feat.feature_key)}
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
