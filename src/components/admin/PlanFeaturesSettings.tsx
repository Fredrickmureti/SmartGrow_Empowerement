// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, Settings2 } from "lucide-react";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { normalizeError } from "@/services/resilience";

interface SubscriptionPlan {
  id: string;
  name: string;
  price_monthly: number;
}

interface PlanFeature {
  id: string;
  plan_id: string;
  feature_key: string;
  is_enabled: boolean;
  limit_value: number | null;
}

interface CatalogFeature {
  feature_key: string;
  label: string;
  category: string;
  description: string | null;
  sort_order: number;
}

// Category display labels
const CATEGORY_LABELS: Record<string, string> = {
  core: "Core Features",
  pos: "Point of Sale",
  reports: "Reports",
  advanced: "Advanced Features",
  operations: "Operations & HR",
  sales: "Sales Documents",
  purchasing: "Purchasing",
  intelligence: "Intelligence",
  limits: "Usage Limits",
  erp: "ERP Suite",
  extras: "Extras",
};

// Features in the "limits" category should show a numeric input
const LIMIT_CATEGORY = "limits";

export function PlanFeaturesSettings() {
  const { toast } = useToast();
  const { formatCurrency } = useAdminCurrency();
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [planFeatures, setPlanFeatures] = useState<Record<string, PlanFeature[]>>({});
  const [catalogFeatures, setCatalogFeatures] = useState<CatalogFeature[]>([]);
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

      // Fetch feature catalog from DB
      const { data: catalogData, error: catalogError } = await (supabase.from as any)("platform_feature_catalog")
        .select("feature_key, label, category, description, sort_order")
        .order("sort_order") as { data: CatalogFeature[] | null; error: any };

      if (catalogError) throw catalogError;
      setCatalogFeatures(catalogData || []);

      // Fetch all plan features
      const { data: featuresData, error: featuresError } = await (supabase.from as any)("plan_feature_access")
        .select("*") as { data: any[] | null; error: any };

      if (featuresError) throw featuresError;

      // Group by plan_id
      const grouped: Record<string, PlanFeature[]> = {};
      (featuresData || []).forEach((f) => {
        if (!grouped[f.plan_id]) grouped[f.plan_id] = [];
        grouped[f.plan_id].push(f);
      });
      setPlanFeatures(grouped);
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Group catalog features by category
  const featuresByCategory = catalogFeatures.reduce<Record<string, CatalogFeature[]>>((acc, f) => {
    if (!acc[f.category]) acc[f.category] = [];
    acc[f.category].push(f);
    return acc;
  }, {});

  const getFeature = (planId: string, featureKey: string): PlanFeature | undefined => {
    return planFeatures[planId]?.find((f) => f.feature_key === featureKey);
  };

  const updateFeature = (planId: string, featureKey: string, updates: Partial<PlanFeature>) => {
    setHasChanges(true);
    setPlanFeatures((prev) => {
      const existing = prev[planId] || [];
      const featureIndex = existing.findIndex((f) => f.feature_key === featureKey);

      if (featureIndex >= 0) {
        const updated = [...existing];
        updated[featureIndex] = { ...updated[featureIndex], ...updates };
        return { ...prev, [planId]: updated };
      } else {
        return {
          ...prev,
          [planId]: [
            ...existing,
            {
              id: `new-${Date.now()}`,
              plan_id: planId,
              feature_key: featureKey,
              is_enabled: updates.is_enabled ?? false,
              limit_value: updates.limit_value ?? null,
            },
          ],
        };
      }
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const features = planFeatures[selectedPlanId] || [];
      
      for (const feature of features) {
        if (feature.id.startsWith("new-")) {
          const { error } = await (supabase.from as any)("plan_feature_access")
            .insert({
              plan_id: feature.plan_id,
              feature_key: feature.feature_key,
              is_enabled: feature.is_enabled,
              limit_value: feature.limit_value,
            });
          if (error) throw error;
        } else {
          const { error } = await (supabase.from as any)("plan_feature_access")
            .update({
              is_enabled: feature.is_enabled,
              limit_value: feature.limit_value,
              updated_at: new Date().toISOString(),
            })
            .eq("id", feature.id);
          if (error) throw error;
        }
      }

      toast({
        title: "Features saved",
        description: "Plan features have been updated successfully.",
      });

      setHasChanges(false);
      await fetchData();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to save features",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const selectedPlan = plans.find((p) => p.id === selectedPlanId);

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
              <Settings2 className="h-5 w-5" />
              Plan Feature Access
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Configure which features are available for each subscription plan. Features are managed in the database.
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
              {Object.entries(featuresByCategory).map(([categoryKey, features]) => (
                <div key={categoryKey} className="space-y-2 sm:space-y-3">
                  <h4 className="font-medium text-xs sm:text-sm text-muted-foreground uppercase tracking-wide">
                    {CATEGORY_LABELS[categoryKey] || categoryKey}
                  </h4>
                  <div className="grid gap-2 sm:gap-3">
                    {features.map((feature) => {
                      const featureData = getFeature(plan.id, feature.feature_key);
                      const isEnabled = featureData?.is_enabled ?? false;
                      const limitValue = featureData?.limit_value;
                      const hasLimit = categoryKey === LIMIT_CATEGORY;

                      return (
                        <div
                          key={feature.feature_key}
                          className="flex items-center justify-between p-2.5 sm:p-3 rounded-lg border bg-card gap-2"
                        >
                          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                            <Switch
                              checked={isEnabled}
                              onCheckedChange={(checked) =>
                                updateFeature(plan.id, feature.feature_key, { is_enabled: checked })
                              }
                              className="shrink-0"
                            />
                            <span className="text-xs sm:text-sm font-medium truncate">{feature.label}</span>
                          </div>

                          {hasLimit && (
                            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                              <Input
                                type="number"
                                placeholder="∞"
                                className="w-16 sm:w-24 h-7 sm:h-8 text-xs sm:text-sm"
                                value={limitValue ?? ""}
                                onChange={(e) =>
                                  updateFeature(plan.id, feature.feature_key, {
                                    limit_value: e.target.value ? parseInt(e.target.value) : null,
                                  })
                                }
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
