// @ts-nocheck - Admin tables not in auto-generated types
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Users, FileText, Building2, HardDrive } from "lucide-react";

interface UsageItem {
  label: string;
  icon: any;
  current: number;
  max: number | null;
  unit?: string;
}

interface OrgUsageLimitsCardProps {
  usageCounters: {
    users_count?: number;
    invoices_this_month?: number;
    businesses_count?: number;
    storage_used_mb?: number;
  } | null;
  plan: {
    max_users: number | null;
    max_invoices_per_month: number | null;
    max_organizations?: number;
    max_storage_mb?: number | null;
    name?: string;
  } | null;
  limitOverrides?: Record<string, any>;
}

export function OrgUsageLimitsCard({ usageCounters, plan, limitOverrides }: OrgUsageLimitsCardProps) {
  if (!usageCounters) return null;

  const getEffectiveLimit = (planLimit: number | null, overrideKey: string): number | null => {
    if (limitOverrides && limitOverrides[overrideKey] !== undefined) {
      return parseInt(limitOverrides[overrideKey]) || null;
    }
    return planLimit;
  };

  const items: UsageItem[] = [
    {
      label: "Active Users",
      icon: Users,
      current: usageCounters.users_count ?? 0,
      max: getEffectiveLimit(plan?.max_users ?? null, "max_users"),
    },
    {
      label: "Invoices (this month)",
      icon: FileText,
      current: usageCounters.invoices_this_month ?? 0,
      max: getEffectiveLimit(plan?.max_invoices_per_month ?? null, "max_invoices"),
    },
    {
      label: "Businesses",
      icon: Building2,
      current: usageCounters.businesses_count ?? 0,
      max: null,
    },
    {
      label: "Storage",
      icon: HardDrive,
      current: usageCounters.storage_used_mb ?? 0,
      max: getEffectiveLimit(plan?.max_storage_mb ?? null, "max_storage_mb"),
      unit: "MB",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          Usage & Limits
          {plan?.name && (
            <Badge variant="outline" className="text-xs font-normal">
              {plan.name}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => {
          const Icon = item.icon;
          const percentage = item.max ? Math.min(100, (item.current / item.max) * 100) : 0;
          const isOverLimit = item.max !== null && item.current >= item.max;
          const isNearLimit = item.max !== null && item.current >= item.max * 0.8 && !isOverLimit;

          return (
            <div key={item.label} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{item.label}</span>
                </div>
                <span className="text-sm font-medium">
                  {item.current}{item.unit ? ` ${item.unit}` : ""}
                  {item.max !== null ? (
                    <span className="text-muted-foreground font-normal"> / {item.max}{item.unit ? ` ${item.unit}` : ""}</span>
                  ) : (
                    <span className="text-muted-foreground font-normal text-xs ml-1">unlimited</span>
                  )}
                </span>
              </div>
              {item.max !== null && (
                <Progress
                  value={percentage}
                  className={`h-1.5 ${isOverLimit ? "[&>div]:bg-destructive" : isNearLimit ? "[&>div]:bg-yellow-500" : ""}`}
                />
              )}
              {isOverLimit && (
                <p className="text-xs text-destructive font-medium">Over limit</p>
              )}
            </div>
          );
        })}

        {limitOverrides && Object.keys(limitOverrides).length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground mb-1">Active Overrides</p>
            <div className="flex flex-wrap gap-1">
              {Object.entries(limitOverrides).map(([key, value]) => (
                <Badge key={key} variant="secondary" className="text-xs">
                  {key}: {String(value)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
