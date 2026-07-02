/**
 * BatchReadinessSnapshotPanel — renders the readiness snapshot row that
 * `payroll_batch_approve` persists in `payroll_batch_readiness_snapshots`
 * (ADR-0045 Phase D). Shows pass/warn/fail counts, the override reason
 * (when used), and a per-finding list. Read-only.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, AlertTriangle, XCircle, FileText } from "lucide-react";
import { format } from "date-fns";

interface Props {
  snapshotId: string | null;
  batchId: string;
}

interface Finding {
  rule_code?: string;
  severity?: string;
  message?: string;
  status?: string;
}

export function BatchReadinessSnapshotPanel({ snapshotId, batchId }: Props) {
  const snapshotQ = useQuery({
    queryKey: ["payroll-batch-readiness-snapshot", snapshotId ?? batchId],
    enabled: !!snapshotId || !!batchId,
    queryFn: async () => {
      let q = supabase
        .from("payroll_batch_readiness_snapshots")
        .select("id, taken_at, taken_by, pass_count, warn_count, fail_count, override_reason, findings")
        .order("taken_at", { ascending: false })
        .limit(1);
      q = snapshotId ? q.eq("id", snapshotId) : q.eq("batch_id", batchId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const snap = snapshotQ.data;
  if (!snap) return null;
  const findings: Finding[] = Array.isArray(snap.findings) ? (snap.findings as unknown as Finding[]) : [];
  const blockers = findings.filter((f) => (f.severity === "fail" || f.severity === "blocker") && f.status !== "passed");
  const warnings = findings.filter((f) => f.severity === "warn" || f.severity === "warning");

  return (
    <Card className="mt-3 border-muted">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" /> Readiness snapshot
          <span className="text-xs text-muted-foreground font-normal ml-2">
            {format(new Date(snap.taken_at), "MMM d, HH:mm")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="default" className="gap-1"><ShieldCheck className="h-3 w-3" />{snap.pass_count} passed</Badge>
          <Badge variant="secondary" className="gap-1"><AlertTriangle className="h-3 w-3" />{snap.warn_count} warnings</Badge>
          <Badge variant={snap.fail_count > 0 ? "destructive" : "outline"} className="gap-1">
            <XCircle className="h-3 w-3" />{snap.fail_count} failed
          </Badge>
        </div>
        {snap.override_reason && (
          <div className="text-xs bg-amber-500/10 border border-amber-500/40 rounded p-2">
            <span className="font-medium">Override:</span> {snap.override_reason}
          </div>
        )}
        {(blockers.length > 0 || warnings.length > 0) && (
          <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
            {[...blockers, ...warnings].slice(0, 50).map((f, idx) => (
              <div key={idx} className="p-2 text-xs flex items-start gap-2">
                <Badge
                  variant={f.severity === "warn" || f.severity === "warning" ? "secondary" : "destructive"}
                  className="text-[10px] mt-0.5"
                >
                  {f.severity ?? "issue"}
                </Badge>
                <div className="flex-1 min-w-0">
                  {f.rule_code && <div className="font-mono text-[10px] text-muted-foreground">{f.rule_code}</div>}
                  <div>{f.message ?? "(no message)"}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
