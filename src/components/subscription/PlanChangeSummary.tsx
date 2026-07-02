/**
 * PlanChangeSummary — surfaced once after a plan change to explain the
 * cascading lifecycle effects: trials that auto-converted, add-ons now
 * billable, and apps that fell into read-only mode.
 *
 * Backed by SECURITY DEFINER RPC `get_recent_plan_change_summary(p_org_id)`
 * which inspects:
 *   - app_trial_status rows converted in the last 24h
 *   - installed apps not in the new plan / not in trial / not overridden
 *   - installed apps with lifecycle_state='readonly' (post-downgrade)
 *
 * Dismissal is local (sessionStorage) — the user only sees it once per
 * plan change. No new edge function needed.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, X, FileLock2, CreditCard, Info } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getAppById } from "@/lib/apps/registry";
import { Link } from "react-router-dom";

interface SummaryPayload {
  plan_name: string | null;
  trials_converted: number;
  addon_apps: number;
  readonly_apps: string[];
}

const STORAGE_PREFIX = "plan-change-summary-dismissed:";

export function PlanChangeSummary() {
  const { currentOrg } = useOrganization();
  const [dismissed, setDismissed] = useState(false);

  const storageKey = useMemo(
    () => (currentOrg?.id ? `${STORAGE_PREFIX}${currentOrg.id}` : null),
    [currentOrg?.id],
  );

  const { data, isLoading } = useQuery<SummaryPayload | null>({
    enabled: !!currentOrg?.id,
    queryKey: ["plan-change-summary", currentOrg?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "get_recent_plan_change_summary",
        { p_org_id: currentOrg!.id },
      );
      if (error) throw error;
      return data as SummaryPayload | null;
    },
    staleTime: 60_000,
  });

  // Build a stable signature so re-running the same change doesn't re-show.
  const signature = useMemo(() => {
    if (!data) return null;
    return [
      data.plan_name ?? "",
      data.trials_converted,
      data.addon_apps,
      (data.readonly_apps ?? []).slice().sort().join(","),
    ].join("|");
  }, [data]);

  useEffect(() => {
    if (!storageKey || !signature) return;
    const stored = sessionStorage.getItem(storageKey);
    setDismissed(stored === signature);
  }, [storageKey, signature]);

  if (isLoading || !data || !storageKey || !signature) return null;

  const noChanges =
    data.trials_converted === 0 &&
    data.addon_apps === 0 &&
    (data.readonly_apps?.length ?? 0) === 0;
  if (noChanges || dismissed) return null;

  const handleDismiss = () => {
    sessionStorage.setItem(storageKey, signature);
    setDismissed(true);
  };

  const readonlyApps = (data.readonly_apps ?? [])
    .map((id) => getAppById(id))
    .filter(Boolean);

  return (
    <Alert className="relative border-primary/30 bg-primary/5">
      <Sparkles className="h-4 w-4 text-primary" />
      <AlertTitle className="pr-8">
        Your plan changed
        {data.plan_name ? ` — now on ${data.plan_name}` : ""}
      </AlertTitle>
      <AlertDescription className="space-y-2 pr-8">
        <p className="text-sm text-muted-foreground">
          Here's what changed for your installed apps:
        </p>
        <ul className="space-y-1.5 text-sm">
          {data.trials_converted > 0 && (
            <li className="flex items-start gap-2">
              <Sparkles className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
              <span>
                <strong>{data.trials_converted}</strong> active{" "}
                {data.trials_converted === 1 ? "trial" : "trials"} converted to
                your new plan — no payment action needed.
              </span>
            </li>
          )}
          {data.addon_apps > 0 && (
            <li className="flex items-start gap-2">
              <CreditCard className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
              <span>
                <strong>{data.addon_apps}</strong> installed{" "}
                {data.addon_apps === 1 ? "app is" : "apps are"} not included in
                this plan and will be billed as add-ons.{" "}
                <Link
                  to="/settings/apps"
                  className="text-primary underline underline-offset-2"
                >
                  Review add-ons
                </Link>
              </span>
            </li>
          )}
          {readonlyApps.length > 0 && (
            <li className="flex items-start gap-2">
              <FileLock2 className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
              <span>
                Read-only:{" "}
                {readonlyApps.map((app, i) => (
                  <span key={app!.id}>
                    <Badge variant="secondary" className="mx-0.5">
                      {app!.name}
                    </Badge>
                    {i < readonlyApps.length - 1 ? " " : ""}
                  </span>
                ))}
                . Existing data is preserved and exportable; new records can't
                be created until the app is back on your plan.
              </span>
            </li>
          )}
        </ul>
        <div className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Historical payslips, journal entries, and reports are never deleted
            when an app is downgraded.
          </span>
        </div>
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-7 w-7"
        onClick={handleDismiss}
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </Button>
    </Alert>
  );
}
