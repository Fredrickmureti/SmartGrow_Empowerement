/**
 * CommercialTimeline
 *
 * Reads `commercial_audit_logs` via the `get_commercial_timeline` RPC and
 * renders a chronological feed of every commercial event for an org:
 * installs, uninstalls, trials starts/expirations/conversions, plan
 * changes, override grants/revokes, and suspensions.
 *
 * Visible to platform admins and org owners/admins (RPC enforces this).
 */
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  PackagePlus,
  PackageMinus,
  Sparkles,
  Clock,
  ArrowUpCircle,
  ShieldCheck,
  ShieldX,
  Pause,
  AlertCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface TimelineRow {
  id: string;
  event_type: string;
  app_id: string | null;
  plan_id: string | null;
  actor_id: string | null;
  actor_email: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

const EVENT_META: Record<
  string,
  { label: string; Icon: typeof PackagePlus; tone: string }
> = {
  app_installed: { label: "App installed", Icon: PackagePlus, tone: "text-emerald-600" },
  app_uninstalled: { label: "App uninstalled", Icon: PackageMinus, tone: "text-muted-foreground" },
  trial_started: { label: "Trial started", Icon: Sparkles, tone: "text-primary" },
  trial_expired: { label: "Trial expired", Icon: Clock, tone: "text-amber-600" },
  trial_converted: { label: "Trial converted", Icon: ArrowUpCircle, tone: "text-emerald-600" },
  trial_cancelled: { label: "Trial cancelled", Icon: Clock, tone: "text-muted-foreground" },
  plan_changed: { label: "Plan changed", Icon: ArrowUpCircle, tone: "text-primary" },
  override_granted: { label: "Override granted", Icon: ShieldCheck, tone: "text-emerald-600" },
  override_revoked: { label: "Override revoked", Icon: ShieldX, tone: "text-destructive" },
  org_suspended: { label: "Organization suspended", Icon: Pause, tone: "text-destructive" },
  org_unsuspended: { label: "Organization unsuspended", Icon: ShieldCheck, tone: "text-emerald-600" },
};

function meta(eventType: string) {
  return (
    EVENT_META[eventType] ?? {
      label: eventType.replace(/_/g, " "),
      Icon: AlertCircle,
      tone: "text-muted-foreground",
    }
  );
}

export function CommercialTimeline({ organizationId }: { organizationId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["commercial-timeline", organizationId],
    queryFn: async (): Promise<TimelineRow[]> => {
      const { data, error } = await (supabase as any).rpc("get_commercial_timeline", {
        _org_id: organizationId,
        _limit: 200,
        _before: null,
      });
      if (error) throw error;
      return (data ?? []) as TimelineRow[];
    },
    staleTime: 30 * 1000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Commercial timeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load timeline.</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No commercial events recorded yet.</p>
        ) : (
          <ol className="relative border-l border-border ml-2 space-y-4">
            {data.map((row) => {
              const m = meta(row.event_type);
              const Icon = m.Icon;
              return (
                <li key={row.id} className="ml-5">
                  <span className="absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full bg-background border border-border">
                    <Icon className={`h-3 w-3 ${m.tone}`} />
                  </span>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{m.label}</span>
                    {row.app_id && <Badge variant="outline" className="text-xs">{row.app_id}</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.actor_email ?? "system"}
                    {row.payload && Object.keys(row.payload).length > 0 && (
                      <span className="ml-2 font-mono">
                        {Object.entries(row.payload)
                          .filter(([k]) => !["app_id", "plan_id"].includes(k))
                          .slice(0, 4)
                          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
