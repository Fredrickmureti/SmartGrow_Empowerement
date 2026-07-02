/**
 * PublisherDiagnosticsPanel — Slice G3.
 *
 * Aggregates the four diagnostic surfaces a pack publisher must monitor
 * before/after publishing a version:
 *   - Unresolved tokens             → payroll_diagnostics (code=TOKEN_UNRESOLVED)
 *   - Rule conflicts                → pack_rule_conflicts
 *   - Failed return runs            → pack_return_run_audit (to_status='failed')
 *   - Upgrade proposal conflicts    → pack_upgrade_proposals (status='conflict')
 *
 * All rows are read-only summaries; the primary action is a deep-link back
 * into the editor via `entity` / `entity_id` search params on PackEntityTabs.
 *
 * Country-agnostic by construction — this panel does no per-country logic;
 * it purely surfaces what the DB has already recorded via outbox-fanned
 * events.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertTriangle, FileWarning, GitPullRequestClosed, Radio } from "lucide-react";
import { format } from "date-fns";

interface Props {
  packId: string;
}

interface DiagRow {
  id: string;
  code: string;
  severity: string | null;
  message: string;
  details: any;
  created_at: string;
  run_id: string | null;
}

interface ConflictRow {
  id: string;
  rule_type: string | null;
  conflict_type: string | null;
  detected_at: string;
  details: any;
}

interface AuditFailureRow {
  id: string;
  run_id: string;
  from_status: string | null;
  reason: string | null;
  created_at: string;
  payload: any;
}

interface ProposalRow {
  id: string;
  status: string;
  created_at: string;
  diff_summary: any;
  target_business_id: string | null;
}

function scrollToEntity(entity: string, id?: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("entity", entity);
  if (id) url.searchParams.set("entity_id", id);
  window.history.replaceState(null, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function PublisherDiagnosticsPanel({ packId }: Props) {
  const tokensQ = useQuery({
    queryKey: ["publisher-diag", "tokens", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_diagnostics")
        .select("id, code, severity, message, details, created_at, run_id")
        .eq("code", "TOKEN_UNRESOLVED")
        .contains("details", { pack_id: packId })
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return [] as DiagRow[];
      return (data ?? []) as DiagRow[];
    },
  });

  const conflictsQ = useQuery({
    queryKey: ["publisher-diag", "conflicts", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_rule_conflicts")
        .select("id, rule_type, conflict_type, detected_at, details")
        .eq("pack_id", packId)
        .order("detected_at", { ascending: false })
        .limit(100);
      if (error) return [] as ConflictRow[];
      return (data ?? []) as ConflictRow[];
    },
  });

  const failuresQ = useQuery({
    queryKey: ["publisher-diag", "return-failures", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_return_run_audit")
        .select("id, run_id, from_status, reason, created_at, payload")
        .eq("to_status", "failed")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return [] as AuditFailureRow[];
      return (data ?? []) as AuditFailureRow[];
    },
  });

  const proposalsQ = useQuery({
    queryKey: ["publisher-diag", "proposals", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_upgrade_proposals")
        .select("id, status, created_at, diff_summary, target_business_id")
        .eq("pack_id", packId)
        .eq("status", "conflict")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return [] as ProposalRow[];
      return (data ?? []) as ProposalRow[];
    },
  });

  const anyLoading =
    tokensQ.isLoading || conflictsQ.isLoading || failuresQ.isLoading || proposalsQ.isLoading;

  const totalOpen =
    (tokensQ.data?.length ?? 0) +
    (conflictsQ.data?.length ?? 0) +
    (failuresQ.data?.length ?? 0) +
    (proposalsQ.data?.length ?? 0);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Radio className="h-4 w-4" /> Publisher diagnostics
            <Badge variant={totalOpen > 0 ? "destructive" : "secondary"} className="ml-2 text-[10px]">
              {anyLoading ? "…" : `${totalOpen} open`}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Aggregated from token resolver misses, rule conflicts, failed return
          generations, and tenant upgrade conflicts. Deep-link back to the
          relevant editor from each row.
        </CardContent>
      </Card>

      <Section
        title="Unresolved tokens"
        icon={<FileWarning className="h-4 w-4" />}
        loading={tokensQ.isLoading}
        empty="No unresolved tokens recorded."
      >
        {(tokensQ.data ?? []).map((row) => {
          const tokenPath = row.details?.token_path ?? row.details?.token ?? "unknown";
          return (
            <Row
              key={row.id}
              headline={<span className="font-mono">{String(tokenPath)}</span>}
              detail={row.message}
              time={row.created_at}
              action={
                <Button size="sm" variant="ghost" onClick={() => scrollToEntity("pack-token")}>
                  Open token registry
                </Button>
              }
            />
          );
        })}
      </Section>

      <Section
        title="Rule conflicts"
        icon={<AlertTriangle className="h-4 w-4" />}
        loading={conflictsQ.isLoading}
        empty="No rule conflicts detected."
      >
        {(conflictsQ.data ?? []).map((row) => (
          <Row
            key={row.id}
            headline={
              <>
                <Badge variant="outline" className="text-[10px] mr-2">{row.rule_type ?? "rule"}</Badge>
                {row.conflict_type ?? "conflict"}
              </>
            }
            detail={typeof row.details === "object" ? JSON.stringify(row.details).slice(0, 200) : String(row.details ?? "")}
            time={row.detected_at}
            action={
              <Button size="sm" variant="ghost" onClick={() => scrollToEntity("rule")}>
                Open rules
              </Button>
            }
          />
        ))}
      </Section>

      <Section
        title="Failed return runs"
        icon={<AlertTriangle className="h-4 w-4" />}
        loading={failuresQ.isLoading}
        empty="No return failures recorded."
      >
        {(failuresQ.data ?? []).map((row) => (
          <Row
            key={row.id}
            headline={<span className="font-mono">run {row.run_id.slice(0, 8)}…</span>}
            detail={row.reason ?? "no reason recorded"}
            time={row.created_at}
            action={
              <Button size="sm" variant="ghost" onClick={() => scrollToEntity("return")}>
                Open returns
              </Button>
            }
          />
        ))}
      </Section>

      <Section
        title="Upgrade proposal conflicts"
        icon={<GitPullRequestClosed className="h-4 w-4" />}
        loading={proposalsQ.isLoading}
        empty="No tenant upgrade conflicts."
      >
        {(proposalsQ.data ?? []).map((row) => (
          <Row
            key={row.id}
            headline={<span>Tenant {row.target_business_id?.slice(0, 8) ?? "n/a"}…</span>}
            detail={typeof row.diff_summary === "object" ? JSON.stringify(row.diff_summary).slice(0, 200) : ""}
            time={row.created_at}
          />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title, icon, loading, empty, children,
}: {
  title: string;
  icon: React.ReactNode;
  loading: boolean;
  empty: string;
  children: React.ReactNode;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const hasRows = arr.filter(Boolean).length > 0;
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : hasRows ? (
          children
        ) : (
          <p className="text-xs text-muted-foreground">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  headline, detail, time, action,
}: {
  headline: React.ReactNode;
  detail?: string | null;
  time: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between border-b last:border-0 py-2 gap-3">
      <div className="min-w-0">
        <div className="text-sm">{headline}</div>
        {detail && <div className="text-xs text-muted-foreground truncate">{detail}</div>}
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {format(new Date(time), "MMM d, yyyy HH:mm")}
        </div>
      </div>
      {action}
    </div>
  );
}
