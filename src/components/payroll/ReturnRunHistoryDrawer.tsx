/**
 * ReturnRunHistoryDrawer — Slice G8.
 *
 * Surfaces the full lifecycle of a `payroll_return_runs` row:
 *   - the amendment chain (`amends_run_id`), walked backwards to the root,
 *   - the transition timeline from `pack_return_run_audit`
 *     (from → to, actor, reason, payload preview).
 *
 * Read-only. All state mutations go through the transition RPC upstream.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { WorkflowSheet, WorkflowSheetSection } from "@/components/workflow/WorkflowSheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { GitBranch, History } from "lucide-react";
import type { ReturnRun } from "@/hooks/payroll/useStatutoryReturns";

interface Props {
  run: ReturnRun | null;
  onClose: () => void;
}

interface AuditRow {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor_user_id: string | null;
  payload: any;
  created_at: string;
}

interface ChainRow {
  id: string;
  serial_number: string;
  status: string;
  generated_at: string;
  amends_run_id: string | null;
}

async function walkChain(rootId: string): Promise<ChainRow[]> {
  const chain: ChainRow[] = [];
  let cursor: string | null = rootId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const { data, error } = await (supabase as any)
      .from("payroll_return_runs")
      .select("id, serial_number, status, generated_at, amends_run_id")
      .eq("id", cursor)
      .maybeSingle();
    if (error || !data) break;
    chain.push(data as ChainRow);
    cursor = (data as any).amends_run_id ?? null;
  }
  return chain;
}

export function ReturnRunHistoryDrawer({ run, onClose }: Props) {
  const runId = run?.id ?? null;

  const chainQ = useQuery({
    queryKey: ["payroll", "return-run", "chain", runId],
    enabled: !!runId,
    queryFn: () => walkChain(runId!),
  });

  const auditQ = useQuery({
    queryKey: ["payroll", "return-run", "audit", runId],
    enabled: !!runId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_return_run_audit")
        .select("id, from_status, to_status, reason, actor_user_id, payload, created_at")
        .eq("run_id", runId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
  });

  if (!run) return null;

  return (
    <WorkflowSheet
      open={!!run}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Return history · ${run.serial_number}`}
      description="Amendment chain and transition audit. Read-only — every row was written by the transition RPC."
    >
      <WorkflowSheetSection number={1} title={<span className="inline-flex items-center gap-2"><GitBranch className="h-4 w-4" />Amendment chain</span>}>
        {chainQ.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (chainQ.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No chain data.</p>
        ) : (
          <div className="space-y-2">
            {(chainQ.data ?? []).map((row, idx) => (
              <div
                key={row.id}
                className={`flex items-center justify-between border rounded-md px-3 py-2 text-sm ${
                  row.id === run.id ? "border-primary bg-primary/5" : ""
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground w-6">
                    {idx === 0 ? "▸" : "↑"}
                  </span>
                  <span className="font-mono truncate">{row.serial_number}</span>
                  <Badge variant="outline" className="text-[10px]">{row.status}</Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(row.generated_at), "MMM d, yyyy HH:mm")}
                </span>
              </div>
            ))}
          </div>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title={<span className="inline-flex items-center gap-2"><History className="h-4 w-4" />Transition timeline</span>}>
        {auditQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (auditQ.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No transitions recorded.</p>
        ) : (
          <ol className="relative border-l pl-4 space-y-3">
            {(auditQ.data ?? []).map((row) => (
              <li key={row.id} className="text-sm">
                <div className="absolute -left-1.5 h-3 w-3 rounded-full bg-primary" />
                <div className="flex items-center gap-2 flex-wrap">
                  {row.from_status && (
                    <>
                      <Badge variant="outline" className="text-[10px]">{row.from_status}</Badge>
                      <span className="text-muted-foreground">→</span>
                    </>
                  )}
                  <Badge className="text-[10px]" variant="secondary">{row.to_status}</Badge>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {format(new Date(row.created_at), "MMM d, yyyy HH:mm:ss")}
                  </span>
                </div>
                {row.reason && (
                  <div className="text-xs text-muted-foreground mt-1">{row.reason}</div>
                )}
                {row.payload && Object.keys(row.payload).length > 0 && (
                  <pre className="text-[10px] bg-muted/40 rounded px-2 py-1 mt-1 overflow-x-auto max-h-32">
                    {JSON.stringify(row.payload, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
