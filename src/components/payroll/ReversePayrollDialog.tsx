import { normalizeError } from "@/services/resilience";
/**
 * Reverse Payroll Dialog
 *
 * Surfaces the canonical `reverse-payroll` edge function (whole-run path) and
 * supports a per-employee correction path via `compute-payroll` with
 * `run_type='correction'` + `parent_run_id`. Loads a confirmation preview from
 * the `payroll_run_reversal_preview` RPC so accountants see the JEs and net
 * amounts that will be reversed before they confirm.
 *
 * Cascade-invalidates dependent React Query caches so Liabilities, Returns,
 * Finance JE list, and payslip lines reflect the reversal without a manual
 * page reload.
 */
import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { PayrollRun } from "@/hooks/usePayroll";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  run: PayrollRun | null;
  organizationId: string | null;
  businessId: string | null;
  onReversed?: () => void;
}

interface PreviewPayslip {
  payslip_id: string;
  employee_id: string;
  employee_name: string;
  employee_number: string | null;
  gross_pay: number;
  net_pay: number;
  reverse_net: number;
}

interface PreviewPayload {
  run: { payroll_number: string; status: string };
  journal_entries: Array<{ id: string; entry_number: string; total_debit: number }>;
  journal_entry_count: number;
  gl_total_debit: number;
  payslips: PreviewPayslip[];
  payslip_count: number;
  has_gl_entry: boolean;
}

export function ReversePayrollDialog({
  open, onOpenChange, run, organizationId, businessId, onReversed,
}: Props) {
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const qc = useQueryClient();

  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"whole" | "selected">("whole");
  const [selectedPayslips, setSelectedPayslips] = useState<Set<string>>(new Set());

  const { data: preview, isLoading } = useQuery({
    queryKey: ["payroll-reversal-preview", run?.id],
    enabled: open && !!run?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "payroll_run_reversal_preview" as any,
        { _run_id: run!.id },
      );
      if (error) throw error;
      return data as unknown as PreviewPayload;
    },
  });

  const reasonValid = reason.trim().length >= 10;

  const selectedPayslipsArr = useMemo(
    () => (preview?.payslips ?? []).filter((p) => selectedPayslips.has(p.payslip_id)),
    [preview, selectedPayslips],
  );

  const reverseMutation = useMutation({
    mutationFn: async () => {
      if (!run || !organizationId) throw new Error("Missing run/organization context");

      if (scope === "whole") {
        const { data, error } = await supabase.functions.invoke("reverse-payroll", {
          body: {
            payroll_run_id: run.id,
            organization_id: organizationId,
            business_id: businessId,
            reason: reason.trim(),
            post_to_gl: true,
          },
        });
        if (error) {
          // Unwrap the structured { error, code } body from the edge function
          // so the toast surfaces "Already reversed" instead of a raw 500 string.
          const { parseEdgeFunctionError } = await import("@/lib/edgeFunctionError");
          const parsed = await parseEdgeFunctionError(error);
          const e: any = new Error(parsed.message);
          e.code = parsed.code;
          throw e;
        }
        return data;
      }

      // Per-employee correction: emit a correction run with negated variable
      // earnings so the engine produces a signed delta against the parent.
      if (selectedPayslipsArr.length === 0) {
        throw new Error("Select at least one employee");
      }
      const variable_earnings = selectedPayslipsArr.map((ps) => ({
        employee_id: ps.employee_id,
        // Negate the original gross — the engine will recompute statutory
        // deductions on the negative base and net out the original GL impact.
        amount: -ps.gross_pay,
        type: "correction",
        notes: `Reversal of ${ps.employee_number ?? ps.employee_name}: ${reason.trim()}`,
      }));
      const { data, error } = await supabase.functions.invoke("compute-payroll", {
        body: {
          organization_id: organizationId,
          business_id: businessId,
          pay_period_start: run.pay_period_start,
          pay_period_end: run.pay_period_end,
          payment_date: new Date().toISOString().split("T")[0],
          run_type: "correction",
          parent_run_id: run.id,
          employee_ids: selectedPayslipsArr.map((p) => p.employee_id),
          variable_earnings,
          reason: reason.trim(),
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      const idempotent = !!data?.idempotent;
      toast({
        title: scope !== "whole"
          ? "Correction run created"
          : idempotent
            ? "Already reversed"
            : "Payroll run reversed",
        description: scope !== "whole"
          ? "A signed correction run was created for the selected employees."
          : idempotent
            ? "This run was already reversed — showing the existing reversal."
            : "GL journal entry reversed and payslips negated.",
      });
      // Cascade-invalidate every dependent surface so reports reconcile in real time.
      for (const key of [
        "payroll-runs", "payroll-liabilities", "payroll-return-runs",
        "journal-entries", "payroll-payments",
        "payroll-run-issues", "payslip-lines",
        "payroll-gl-readiness", "app-setup-status",
      ]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      qc.invalidateQueries({ queryKey: ["payroll-reversal-preview", run?.id] });
      onReversed?.();
      onOpenChange(false);
      setReason("");
      setSelectedPayslips(new Set());
      setScope("whole");
    },
    onError: (err: any) => {
      toast({
        title: err?.code === "ALREADY_REVERSED" ? "Already reversed" : "Reversal failed",
        description: normalizeError(err).message ?? String(err),
        variant: err?.code === "ALREADY_REVERSED" ? "default" : "destructive",
      });
    },
  });

  if (!run) return null;

  const canSubmit = reasonValid
    && !reverseMutation.isPending
    && (scope === "whole" || selectedPayslips.size > 0);

  const footer = (
    <>
      <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reverseMutation.isPending}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        onClick={() => reverseMutation.mutate()}
        disabled={!canSubmit}
      >
        {reverseMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        <RotateCcw className="h-4 w-4 mr-2" />
        {scope === "whole" ? "Reverse run" : `Create correction (${selectedPayslips.size})`}
      </Button>
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(v) => { if (!reverseMutation.isPending) onOpenChange(v); }}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <RotateCcw className="h-5 w-5" />
          Reverse {run.payroll_number}
        </span>
      }
      description="Reverses the payroll sub-ledger and the linked General Ledger journal entry through the canonical void path. The original run is kept for audit; a paired reversal is posted on today's date."
      footer={footer}
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading reversal preview…
        </div>
      )}

      {preview && (
        <>
          <WorkflowSheetSection number={1} title="Reversal preview" fullWidth>
            <Alert variant={preview.has_gl_entry ? "default" : "destructive"}>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>What will happen</AlertTitle>
              <AlertDescription className="text-xs space-y-1 mt-1">
                <div>
                  • <b>{preview.journal_entry_count}</b> journal entr{preview.journal_entry_count === 1 ? "y" : "ies"}{" "}
                  {preview.has_gl_entry ? `(total ${formatCurrency(preview.gl_total_debit || 0)})` : "found"}{" "}
                  will be reversed via <code>void_journal_entry_atomic</code>.
                </div>
                <div>
                  • <b>{preview.payslip_count}</b> payslip{preview.payslip_count === 1 ? "" : "s"} will be negated;
                  a reversal run is created and the original is marked reversed.
                </div>
                {!preview.has_gl_entry && (
                  <div className="text-amber-700">
                    ⚠ This run was never posted to GL — only the payroll sub-ledger will be reversed.
                  </div>
                )}
              </AlertDescription>
            </Alert>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Scope" fullWidth>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as "whole" | "selected")}>
              <label className="flex items-start gap-2 cursor-pointer">
                <RadioGroupItem value="whole" className="mt-1" />
                <div className="text-sm">
                  <div className="font-medium">Reverse whole run</div>
                  <div className="text-xs text-muted-foreground">
                    Negates every payslip and reverses the linked GL entry. Mirrors Odoo's <em>Refund payslip batch</em>.
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <RadioGroupItem value="selected" className="mt-1" />
                <div className="text-sm">
                  <div className="font-medium">Selected employees only (correction run)</div>
                  <div className="text-xs text-muted-foreground">
                    Creates a correction run with negated lines for the chosen employees. Original stays intact.
                  </div>
                </div>
              </label>
            </RadioGroup>

            {scope === "selected" && (
              <div className="border rounded-md mt-3">
                <div className="px-3 py-2 border-b text-xs font-medium flex items-center justify-between">
                  <span>Select employees ({selectedPayslips.size}/{preview.payslip_count})</span>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => {
                      if (selectedPayslips.size === preview.payslips.length) {
                        setSelectedPayslips(new Set());
                      } else {
                        setSelectedPayslips(new Set(preview.payslips.map((p) => p.payslip_id)));
                      }
                    }}
                  >
                    {selectedPayslips.size === preview.payslips.length ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {preview.payslips.map((ps) => (
                    <label key={ps.payslip_id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                      <Checkbox
                        checked={selectedPayslips.has(ps.payslip_id)}
                        onCheckedChange={(v) => {
                          setSelectedPayslips((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(ps.payslip_id);
                            else next.delete(ps.payslip_id);
                            return next;
                          });
                        }}
                      />
                      <span className="flex-1 truncate">
                        {ps.employee_name || ps.employee_number || ps.employee_id}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {formatCurrency(ps.reverse_net)}
                      </Badge>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </WorkflowSheetSection>
        </>
      )}

      <WorkflowSheetSection number={3} title="Audit reason" fullWidth>
        <WorkflowField label="Reason" htmlFor="reverse-reason" required>
          <Textarea
            id="reverse-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Audit trail — minimum 10 characters (e.g. duplicate posting, wrong period, employee terminated mid-cycle)"
            rows={3}
          />
        </WorkflowField>
        {!reasonValid && reason.length > 0 && (
          <p className="text-xs text-destructive">At least 10 characters.</p>
        )}
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}


export default ReversePayrollDialog;
