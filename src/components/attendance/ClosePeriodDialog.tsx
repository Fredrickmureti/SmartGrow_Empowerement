/**
 * ClosePeriodDialog — HR-grade period-close workflow.
 *
 * One-shot lock for a date range across the caller's org (optionally
 * narrowed to a branch). Surfaces pre-flight counts (pending corrections,
 * missing checkouts) before the destructive confirm so HR can resolve
 * issues before payroll cutoff instead of after.
 *
 * Calls SECURITY DEFINER RPC `attendance_close_period`.
 *
 * Pass 5 — Attendance: presentation migrated from `Dialog` to
 * `WorkflowSheet`. Business logic, RPC payload, and toasts unchanged.
 */
import { useState } from "react";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Loader2, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useBranches } from "@/hooks/useBranches";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Preview = {
  locked_count: number;
  unresolved_corrections: number;
  missing_checkouts: number;
  from: string;
  to: string;
  branch_id: string | null;
};

export function ClosePeriodDialog({ open, onOpenChange }: Props) {
  const lastMonth = subMonths(new Date(), 1);
  const [from, setFrom] = useState(format(startOfMonth(lastMonth), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(endOfMonth(lastMonth), "yyyy-MM-dd"));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const { currentBranch } = useBranches();
  const qc = useQueryClient();

  const run = async () => {
    if (!from || !to || from > to) {
      toast.error("Pick a valid date range");
      return;
    }
    const blockers =
      "This will lock every attendance row in the selected range. " +
      "Pending corrections and missing checkouts can no longer be edited. Continue?";
    if (!window.confirm(blockers)) return;

    setBusy(true);
    try {
      const { data, error } = await supabase.rpc(
        "attendance_close_period" as any,
        {
          _from: from,
          _to: to,
          _branch_id: currentBranch?.id ?? null,
        },
      );
      if (error) throw error;
      setResult(data as Preview);
      toast.success(`Locked ${((data as any)?.locked_count ?? 0)} row(s)`);
      qc.invalidateQueries({ queryKey: ["attendance"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not close period");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setResult(null);
    onOpenChange(false);
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => {
        if (!o) setResult(null);
        onOpenChange(o);
      }}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          Close attendance period
        </span>
      }
      description="Locks attendance rows in the range so payroll can run on a stable dataset. Locked rows cannot be edited until reopened by HR."
      headerRight={
        currentBranch?.name ? (
          <Badge variant="outline">{currentBranch.name}</Badge>
        ) : undefined
      }
      footer={
        !result ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={run} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Close period
            </Button>
          </>
        ) : (
          <Button onClick={reset}>Done</Button>
        )
      }
    >
      {!result ? (
        <>
          <WorkflowSheetSection number={1} title="Range">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <WorkflowField label="From" htmlFor="close-from">
                <Input
                  id="close-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </WorkflowField>
              <WorkflowField label="To" htmlFor="close-to">
                <Input
                  id="close-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </WorkflowField>
            </div>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Before you close">
            <div className="text-xs text-muted-foreground rounded-md border border-amber-500/40 bg-amber-500/5 p-3 flex gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <span>
                Resolve any pending corrections and missing checkouts first.
                The Approvals queue and Reports → Exceptions help you find them.
              </span>
            </div>
          </WorkflowSheetSection>
        </>
      ) : (
        <WorkflowSheetSection number={1} title="Period closed">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Lock applied
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>
                Range:{" "}
                <span className="text-foreground tabular-nums">
                  {result.from} → {result.to}
                </span>
              </li>
              <li>
                Rows locked:{" "}
                <span className="text-foreground tabular-nums">{result.locked_count}</span>
              </li>
              <li>
                Unresolved corrections at close:{" "}
                <span className="text-foreground tabular-nums">{result.unresolved_corrections}</span>
              </li>
              <li>
                Missing checkouts at close:{" "}
                <span className="text-foreground tabular-nums">{result.missing_checkouts}</span>
              </li>
            </ul>
          </div>
        </WorkflowSheetSection>
      )}
    </WorkflowSheet>
  );
}
