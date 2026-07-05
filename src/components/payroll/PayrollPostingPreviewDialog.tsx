/**
 * PayrollPostingPreviewDialog — run-scoped, read-only projection of the
 * journal entry the payroll engine WOULD produce for a specific payroll
 * run. Calls `post-payroll-gl` with `dry_run: true`.
 *
 * Architectural boundary (ADR: Payroll Posting Simulation Boundary):
 *
 *   • Preview is bound to a SPECIFIC run — never "the latest one".
 *   • Preview NEVER short-circuits on existing-JE / SoD / closed-period.
 *     Those become badges / warnings inside the payload so the accountant
 *     can inspect the projected posting even when the run is already
 *     posted (comparison, reversal planning, audit).
 *   • Preview writes NOTHING to the accounting ledger. The only DB side
 *     effect is a `payroll_posting_previewed` audit_logs row (non-financial).
 *
 * This dialog replaces the old "Simulate posting" button that lived on
 * the GL Account Mapping page. That button was mis-placed (auto-selected
 * "the latest draft/computed run" so accountants could not preview a
 * specific run) and its response shared the write-path idempotency
 * short-circuit, so previewing a run that already had a stray JE looked
 * indistinguishable from "the sale posted successfully".
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, PlayCircle, Info } from "lucide-react";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface SimLine {
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  debit: number;
  credit: number;
  description: string;
}

interface PreviewWarning {
  code: string;
  message: string;
  details?: unknown;
}

interface PreviewResult {
  dry_run: true;
  payroll_run_id: string;
  payroll_number: string;
  pay_period_end: string;
  run_status: string;
  employee_count: number;
  lines: SimLine[];
  total_debits: number;
  total_credits: number;
  balanced: boolean;
  warnings: PreviewWarning[];
  already_posted: boolean;
  existing_journal_entry_id: string | null;
}

export interface PayrollPostingPreviewDialogProps {
  /** The payroll run to preview. Required — preview is run-scoped. */
  runId: string;
  organizationId: string;
  businessId: string | null;
  /** Custom trigger; defaults to a small outline "Preview posting" button. */
  trigger?: React.ReactNode;
}

export function PayrollPostingPreviewDialog({
  runId,
  organizationId,
  businessId,
  trigger,
}: PayrollPostingPreviewDialogProps) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runSim = useMutation({
    mutationFn: async () => {
      setErrorMsg(null);
      const { data, error } = await supabase.functions.invoke("post-payroll-gl", {
        body: {
          payroll_run_id: runId,
          organization_id: organizationId,
          business_id: businessId ?? null,
          dry_run: true,
        },
      });
      if (error) {
        let parsed: any = null;
        try {
          const ctx: any = (error as any)?.context;
          if (ctx && typeof ctx.json === "function") parsed = await ctx.json();
        } catch { /* keep parsed = null */ }
        const msg =
          parsed?.message ||
          parsed?.error ||
          (error as any)?.message ||
          "Preview failed";
        throw new Error(msg);
      }
      const d = data as any;
      if (d?.error) throw new Error(d.message || d.error);
      return d as PreviewResult;
    },
    onSuccess: (r) => {
      if (!Array.isArray(r.lines)) {
        setErrorMsg("Unexpected response from posting engine (no lines returned).");
        setResult(null);
        return;
      }
      setResult(r);
      if (!r.balanced) {
        toast.warning("Projected JE is not balanced — investigate.");
      } else {
        toast.success(`Preview generated for ${r.payroll_number}`);
      }
    },
    onError: (e: any) => {
      const msg = normalizeError(e).message || "Preview failed";
      setErrorMsg(msg);
      setResult(null);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setResult(null);
          setErrorMsg(null);
        } else {
          // Auto-run on open so the accountant sees the projection immediately.
          runSim.mutate();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <PlayCircle className="h-4 w-4 mr-1.5" />
            Preview posting
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl p-0 flex flex-col gap-0 max-h-[90vh]">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>Payroll posting preview</DialogTitle>
          <DialogDescription>
            Read-only projection of the journal entry this run would produce.
            Nothing is written to the general ledger.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {runSim.isPending && (
            <div className="py-6 text-sm text-muted-foreground">Generating preview…</div>
          )}

          {errorMsg && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Preview failed
              </div>
              <div className="mt-1 text-destructive/90">{errorMsg}</div>
            </div>
          )}

          {result && (
            <>
              {result.already_posted && (
                <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-blue-700 dark:text-blue-400">
                    <Info className="h-4 w-4" />
                    This run is already posted to the GL
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Existing journal entry{" "}
                    <span className="font-mono">
                      {result.existing_journal_entry_id?.slice(0, 8)}
                    </span>
                    . The preview below reflects what the engine would produce today for
                    comparison — a second post is blocked by the idempotency guard.
                  </div>
                </div>
              )}

              {result.warnings?.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm space-y-1">
                  <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                    Warnings that would block the real post
                  </div>
                  <ul className="ml-6 list-disc text-amber-800 dark:text-amber-300">
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge variant={result.balanced ? "outline" : "destructive"}>
                  {result.balanced ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Balanced
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Unbalanced
                    </>
                  )}
                </Badge>
                <Badge variant="outline" className="font-mono uppercase text-xs">
                  {result.run_status}
                </Badge>
                <span className="text-muted-foreground">
                  {result.lines.length} lines · {result.employee_count} employees
                </span>
                <span>DR {result.total_debits.toFixed(2)}</span>
                <span>CR {result.total_credits.toFixed(2)}</span>
              </div>
              <div className="max-h-[420px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead className="min-w-[180px]">Account</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">
                          <div className="font-mono text-xs">{l.account_code ?? "?"}</div>
                          <div>{l.account_name ?? l.account_id.slice(0, 8)}</div>
                        </TableCell>
                        <TableCell className="text-xs capitalize">
                          {l.account_type ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs">{l.description}</TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {l.debit > 0 ? l.debit.toFixed(2) : ""}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {l.credit > 0 ? l.credit.toFixed(2) : ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="px-6 py-3 border-t flex-row items-center gap-2">
          <p className="text-xs text-muted-foreground mr-auto">
            Read-only preview — no journal entry is written and the run status is
            not changed.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runSim.mutate()}
            disabled={runSim.isPending}
          >
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PayrollPostingPreviewDialog;
