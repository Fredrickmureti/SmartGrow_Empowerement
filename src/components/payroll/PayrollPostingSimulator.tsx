/**
 * PayrollPostingSimulator — Phase 4.
 *
 * Enterprise-parity feature: preview the journal entry the payroll engine
 * WOULD produce for the latest draft/computed run, without touching the
 * general ledger. Calls `post-payroll-gl` with `dry_run: true`, so every
 * validation gate (missing mappings, role violations, fiscal period lock)
 * runs exactly as it would at real posting time — the accountant learns
 * about problems while sitting on the mapping page rather than after
 * approvals have already routed.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, PlayCircle } from "lucide-react";
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

interface SimResult {
  dry_run: true;
  payroll_run_id: string;
  payroll_number: string;
  pay_period_end: string;
  employee_count: number;
  lines: SimLine[];
  total_debits: number;
  total_credits: number;
  balanced: boolean;
}

export function PayrollPostingSimulator() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;

  // Find the latest run that would benefit from a preview (draft or
  // computed). Posted runs are excluded — they already have a JE.
  const latestRunQuery = useQuery({
    queryKey: ["payroll-sim-latest-run", orgId, bizId],
    enabled: !!orgId && open,
    queryFn: async () => {
      let q = supabase
        .from("payroll_runs")
        .select("id, payroll_number, status, pay_period_end")
        .eq("organization_id", orgId!)
        .in("status", ["draft", "computed"])
        .order("pay_period_end", { ascending: false })
        .limit(1);
      if (bizId) q = q.eq("business_id", bizId);
      const { data, error } = await q;
      if (error) throw error;
      return (data?.[0] ?? null) as {
        id: string;
        payroll_number: string;
        status: string;
        pay_period_end: string;
      } | null;
    },
  });

  const runSim = useMutation({
    mutationFn: async (runId: string) => {
      setErrorMsg(null);
      const { data, error } = await supabase.functions.invoke("post-payroll-gl", {
        body: {
          payroll_run_id: runId,
          organization_id: orgId,
          business_id: bizId ?? null,
          dry_run: true,
        },
      });
      if (error) throw error;
      // Edge function returns 400 for missing_mappings — surfaces via data
      if ((data as any)?.error) throw new Error((data as any).message || (data as any).error);
      return data as SimResult;
    },
    onSuccess: (r) => {
      setResult(r);
      if (!r.balanced) {
        toast.warning("Simulated JE is not balanced — investigate.");
      } else {
        toast.success(`Preview generated for ${r.payroll_number}`);
      }
    },
    onError: (e: any) => {
      const msg = normalizeError(e).message || "Simulation failed";
      setErrorMsg(msg);
      setResult(null);
    },
  });

  const latestRun = latestRunQuery.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setResult(null);
          setErrorMsg(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <PlayCircle className="h-4 w-4 mr-1.5" />
          Simulate posting
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Payroll posting simulation</DialogTitle>
        </DialogHeader>

        {latestRunQuery.isLoading ? (
          <div className="py-6 text-sm text-muted-foreground">Loading latest run…</div>
        ) : !latestRun ? (
          <div className="py-6 text-sm text-muted-foreground">
            No draft or computed payroll run to simulate. Compute a run first.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <div className="font-medium">Run {latestRun.payroll_number}</div>
                <div className="text-xs text-muted-foreground">
                  Period end {latestRun.pay_period_end} · status{" "}
                  <span className="font-mono">{latestRun.status}</span>
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => runSim.mutate(latestRun.id)}
                disabled={runSim.isPending}
              >
                {runSim.isPending ? "Simulating…" : "Run simulation"}
              </Button>
            </div>

            {errorMsg && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  Simulation failed
                </div>
                <div className="mt-1 text-destructive/90">{errorMsg}</div>
              </div>
            )}

            {result && (
              <>
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
        )}

        <DialogFooter>
          <p className="text-xs text-muted-foreground mr-auto">
            Read-only preview — no journal entry is written and the run status is
            not changed.
          </p>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
