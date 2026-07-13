// @ts-nocheck - Admin tables not in auto-generated types
/**
 * FeaturePeekSheet — read-mostly peek for a platform feature catalog entry.
 * Opened via `?featurePeek=<featureId>` on the Feature Catalog list.
 * Follows the peek convention in `docs/design-system/audit/platform-admin.md`.
 *
 * Uses its own query key (`featurePeek`) so it does NOT collide with any
 * parent list's own `?peek=` param. The peek fetches plan-tier
 * availability lazily (single query joining `plan_feature_access` →
 * `subscription_plans`) so the list page doesn't pay the cost until a
 * user actually opens a peek.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Pencil, CheckCircle2, MinusCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DocumentPeekShell } from "@/design-system";

export interface FeaturePeekEntry {
  id: string;
  feature_key: string;
  label: string;
  category: string;
  description: string | null;
  sort_order: number;
}

interface PlanAvailability {
  plan_id: string;
  plan_name: string;
  is_enabled: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feature: FeaturePeekEntry | null;
  categoryLabel: string;
}

export function FeaturePeekSheet({
  open,
  onOpenChange,
  feature,
  categoryLabel,
}: Props) {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PlanAvailability[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !feature) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Load all plans + which have this feature enabled.
        const { data: planRows, error: planErr } = await (supabase.from as any)(
          "subscription_plans",
        )
          .select("id, name, sort_order")
          .order("sort_order", { ascending: true });
        if (planErr) throw planErr;

        const { data: accessRows, error: accessErr } = await (supabase.from as any)(
          "plan_feature_access",
        )
          .select("plan_id, is_enabled")
          .eq("feature_key", feature.feature_key);
        if (accessErr) throw accessErr;

        const enabledMap = new Map<string, boolean>();
        for (const r of accessRows || []) {
          enabledMap.set(r.plan_id, !!r.is_enabled);
        }

        const result: PlanAvailability[] = (planRows || []).map((p: any) => ({
          plan_id: p.id,
          plan_name: p.name,
          is_enabled: enabledMap.get(p.id) === true,
        }));
        if (!cancelled) setPlans(result);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load availability");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, feature]);

  const enabledCount = plans.filter((p) => p.is_enabled).length;

  const title = feature ? (
    <div className="flex items-center gap-3 min-w-0">
      <div className="h-10 w-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
        <BookOpen className="h-5 w-5 text-primary" />
      </div>
      <div className="min-w-0">
        <div className="text-base font-semibold truncate">{feature.label}</div>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {feature.feature_key}
        </p>
      </div>
    </div>
  ) : (
    "Feature"
  );

  return (
    <DocumentPeekShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      loading={loading}
      error={error}
      extraHeaderActions={
        feature && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              navigate(
                `/admin-management/plan-builder/features/${feature.id}/edit`,
              );
            }}
          >
            <Pencil className="mr-1.5 h-4 w-4" />
            Edit
          </Button>
        )
      }
    >
      {feature && (
        <div className="space-y-4 p-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {categoryLabel}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {enabledCount} of {plans.length} plans
            </Badge>
          </div>

          {feature.description && (
            <>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  Description
                </p>
                <p className="text-sm">{feature.description}</p>
              </div>
              <Separator />
            </>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Plan availability</h3>
            {plans.length === 0 ? (
              <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
                No plans defined yet.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {plans.map((p) => (
                  <li
                    key={p.plan_id}
                    className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm"
                  >
                    <span className="font-medium truncate">{p.plan_name}</span>
                    {p.is_enabled ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Enabled
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <MinusCircle className="h-3.5 w-3.5" />
                        Not included
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </DocumentPeekShell>
  );
}
