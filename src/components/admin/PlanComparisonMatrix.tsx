// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, X, Crown, Users, Building2, Sparkles, DollarSign } from "lucide-react";
import { APP_REGISTRY } from "@/lib/apps/registry";

interface Plan {
  id: string;
  name: string;
  price_monthly: number;
  price_yearly: number | null;
  price_per_user_monthly: number | null;
  price_per_user_yearly: number | null;
  max_users: number | null;
  max_organizations: number;
  is_active: boolean;
  is_popular: boolean;
}

interface AppAccess {
  plan_id: string;
  app_id: string;
  is_enabled: boolean;
}

interface FeatureAccess {
  plan_id: string;
  feature_key: string;
  is_enabled: boolean;
}

/**
 * Only REAL premium features that exist in the platform.
 */
const PREMIUM_FEATURE_LABELS: Record<string, string> = {
  multi_currency: "Multi-Currency",
  ai_assistant: "AI Assistant",
  audit_logs: "Audit Logs",
  team_management: "Team Management",
};

export function PlanComparisonMatrix() {
  const { formatCurrency } = useAdminCurrency();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [appAccess, setAppAccess] = useState<AppAccess[]>([]);
  const [featureAccess, setFeatureAccess] = useState<FeatureAccess[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [plansRes, appsRes, featuresRes] = await Promise.all([
        supabase.from("platform_subscription_plans").select("*").order("price_monthly"),
        supabase.from("plan_app_access").select("plan_id, app_id, is_enabled"),
        supabase.from("plan_feature_access").select("plan_id, feature_key, is_enabled"),
      ]);
      setPlans((plansRes.data || []) as Plan[]);
      setAppAccess((appsRes.data || []) as AppAccess[]);
      setFeatureAccess((featuresRes.data || []) as FeatureAccess[]);
      setLoading(false);
    }
    load();
  }, []);

  const activePlans = useMemo(() => plans.filter(p => p.is_active), [plans]);

  const appKeys = useMemo(() => {
    return APP_REGISTRY
      .filter(a => !a.isPlatform)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }, []);

  const premiumFeatureKeys = useMemo(() => {
    const keys = new Set<string>();
    featureAccess.forEach(f => keys.add(f.feature_key));
    return Array.from(keys).filter(k => k in PREMIUM_FEATURE_LABELS).sort();
  }, [featureAccess]);

  const hasApp = (planId: string, appId: string) =>
    appAccess.some(a => a.plan_id === planId && a.app_id === appId && a.is_enabled);

  const hasFeature = (planId: string, key: string) =>
    featureAccess.some(f => f.plan_id === planId && f.feature_key === key && f.is_enabled);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Crown className="h-5 w-5 text-primary" />
          Plan Comparison Preview
        </CardTitle>
        <CardDescription>
          This is what customers see when comparing plans. Manage apps and features in the other tabs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-3 font-medium text-muted-foreground min-w-[180px]">
                  Feature
                </th>
                {activePlans.map(plan => (
                  <th key={plan.id} className="text-center py-3 px-4 min-w-[140px]">
                    <div className="font-semibold">{plan.name}</div>
                    <div className="text-xs text-muted-foreground font-normal mt-0.5">
                      {plan.price_monthly === 0 ? 'Free' : `${formatCurrency(plan.price_monthly)}/mo`}
                    </div>
                    {(plan.price_per_user_monthly ?? 0) > 0 && (
                      <div className="text-xs text-muted-foreground font-normal">
                        + {formatCurrency(plan.price_per_user_monthly!)}/user
                      </div>
                    )}
                    {plan.is_popular && (
                      <Badge variant="default" className="mt-1 text-[9px] bg-amber-500">Popular</Badge>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Limits Section */}
              <tr className="bg-muted/30">
                <td colSpan={activePlans.length + 1} className="py-2 px-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Limits
                </td>
              </tr>
              <LimitRow
                label="Users"
                icon={<Users className="h-3.5 w-3.5" />}
                plans={activePlans}
                getValue={p => p.max_users === null ? "Unlimited" : `${p.max_users}`}
              />
              <LimitRow
                label="Organizations"
                icon={<Building2 className="h-3.5 w-3.5" />}
                plans={activePlans}
                getValue={p => `${p.max_organizations}`}
              />

              {/* Apps Section */}
              <tr className="bg-muted/30">
                <td colSpan={activePlans.length + 1} className="py-2 px-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Apps
                </td>
              </tr>
              {appKeys.map(app => (
                <tr key={app.id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="py-2 px-3 flex items-center gap-2">
                    <app.icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {app.name}
                  </td>
                  {activePlans.map(plan => (
                    <td key={plan.id} className="text-center py-2 px-4">
                      {hasApp(plan.id, app.id) ? (
                        <Check className="h-4 w-4 text-emerald-500 mx-auto" />
                      ) : (
                        <X className="h-4 w-4 text-muted-foreground/30 mx-auto" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}

              {/* Premium Features Section */}
              {premiumFeatureKeys.length > 0 && (
                <>
                  <tr className="bg-muted/30">
                    <td colSpan={activePlans.length + 1} className="py-2 px-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5" />
                        Premium Features
                      </div>
                    </td>
                  </tr>
                  {premiumFeatureKeys.map(key => (
                    <tr key={key} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-2 px-3">{PREMIUM_FEATURE_LABELS[key] || key}</td>
                      {activePlans.map(plan => (
                        <td key={plan.id} className="text-center py-2 px-4">
                          {hasFeature(plan.id, key) ? (
                            <Check className="h-4 w-4 text-emerald-500 mx-auto" />
                          ) : (
                            <X className="h-4 w-4 text-muted-foreground/30 mx-auto" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function LimitRow({
  label,
  icon,
  plans,
  getValue,
}: {
  label: string;
  icon: React.ReactNode;
  plans: Plan[];
  getValue: (plan: Plan) => string;
}) {
  return (
    <tr className="border-b border-border/50 hover:bg-muted/20">
      <td className="py-2 px-3 flex items-center gap-2">
        {icon}
        {label}
      </td>
      {plans.map(plan => (
        <td key={plan.id} className="text-center py-2 px-4">
          <Badge variant="outline" className="text-[10px] font-medium">
            {getValue(plan)}
          </Badge>
        </td>
      ))}
    </tr>
  );
}
