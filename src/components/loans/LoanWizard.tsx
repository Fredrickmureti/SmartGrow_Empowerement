import { normalizeError } from "@/services/resilience";
/**
 * LoanWizard — multi-step, type-driven loan/advance creation.
 *
 * Step 1: Pick a configured loan_type (no hardcoded enum).
 * Step 2: Dynamic field set, sourced from loan_type.dynamic_field_schema
 *         + repayment_method (percent/floor/cap when applicable).
 * Step 3: Schedule preview (dry-run RPC) — skipped for percent_of_net.
 * Step 4: Submit. Loan is created in `draft` status; approval generates
 *         the persistent schedule.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ChevronLeft, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useEmployees } from "@/hooks/useEmployees";
import { useLoanTypes, type LoanType, type RepaymentMethod } from "@/hooks/useLoanTypes";
import { useEmployeeLoans, type LoanScheduleRow } from "@/hooks/useEmployeeLoans";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { supabase } from "@/integrations/supabase/client";

type Step = 1 | 2 | 3 | 4;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function LoanWizard({ open, onClose }: Props) {
  const { activeEmployees } = useEmployees();
  const { activeLoanTypes, isLoading: typesLoading } = useLoanTypes();
  const { createLoan, refreshLoans } = useEmployeeLoans();

  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);

  const [employeeId, setEmployeeId] = useState("");
  const [loanTypeId, setLoanTypeId] = useState("");
  const [form, setForm] = useState<Record<string, any>>({});
  const [repaymentMethod, setRepaymentMethod] = useState<RepaymentMethod>("fixed_installment");
  const [percent, setPercent] = useState<string>("");
  const [floor, setFloor] = useState<string>("");
  const [cap, setCap] = useState<string>("");
  const [schedulePreview, setSchedulePreview] = useState<LoanScheduleRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loanType: LoanType | undefined = useMemo(
    () => activeLoanTypes.find((t) => t.id === loanTypeId),
    [activeLoanTypes, loanTypeId],
  );

  // When a loan type is picked, seed defaults
  useEffect(() => {
    if (!loanType) return;
    setRepaymentMethod(loanType.default_repayment_method);
    setForm((f) => ({
      ...f,
      total_installments: f.total_installments ?? loanType.default_installments ?? 12,
      interest_rate: f.interest_rate ?? 0,
      start_date: f.start_date ?? new Date().toISOString().slice(0, 10),
    }));
    if (loanType.default_max_pct_of_net && !cap) setCap(String(loanType.default_max_pct_of_net));
    if (loanType.default_min_net_pay_floor && !floor) setFloor(String(loanType.default_min_net_pay_floor));
  }, [loanType]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = loanType?.dynamic_field_schema?.fields || [];

  const reset = () => {
    setStep(1);
    setEmployeeId(""); setLoanTypeId("");
    setForm({}); setPercent(""); setFloor(""); setCap("");
    setSchedulePreview([]); setRepaymentMethod("fixed_installment");
  };

  const handleClose = () => { if (!submitting) { reset(); onClose(); } };

  const canAdvanceFrom1 = !!employeeId && !!loanTypeId;
  const canAdvanceFrom2 = useMemo(() => {
    if (!loanType) return false;
    for (const f of fields) {
      if (f.required && (form[f.key] === undefined || form[f.key] === "" || form[f.key] === null)) return false;
    }
    if (repaymentMethod === "percent_of_net" && !percent) return false;
    return true;
  }, [loanType, fields, form, repaymentMethod, percent]);

  const goToPreview = async () => {
    if (!loanType) return;
    if (repaymentMethod === "percent_of_net") {
      // No fixed schedule — go straight to confirm
      setSchedulePreview([]);
      setStep(4);
      return;
    }
    setPreviewLoading(true);
    try {
      // Build a temporary calc — we use the same formula the RPC uses.
      const principal = Number(form.principal_amount || 0);
      const interest = Number(form.interest_rate || 0) / 100;
      const total = principal * (1 + interest);
      const n = repaymentMethod === "one_off_next_payroll" ? 1 : Math.max(1, Number(form.total_installments || 1));
      const amt = Math.round((total / n) * 100) / 100;
      const startDate = new Date(form.start_date);
      const rows: LoanScheduleRow[] = [];
      let remaining = total;
      for (let i = 1; i <= n; i++) {
        const periodStart = new Date(startDate.getFullYear(), startDate.getMonth() + (i - 1), startDate.getDate());
        const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0);
        const scheduled = i === n ? Math.round(remaining * 100) / 100 : amt;
        rows.push({
          id: `preview-${i}`,
          loan_id: "preview",
          sequence: i,
          due_period_start: periodStart.toISOString().slice(0, 10),
          due_period_end: periodEnd.toISOString().slice(0, 10),
          scheduled_amount: scheduled,
          paid_amount: 0, status: "pending", payslip_id: null, repayment_id: null, notes: null,
        });
        remaining -= amt;
      }
      setSchedulePreview(rows);
      setStep(3);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!loanType) return;
    setSubmitting(true);
    try {
      await createLoan({
        employee_id: employeeId,
        loan_type_id: loanTypeId,
        description: form.description || null,
        principal_amount: Number(form.principal_amount || 0),
        interest_rate: Number(form.interest_rate || 0),
        total_installments: Number(form.total_installments || 1),
        start_date: form.start_date,
        repayment_method: repaymentMethod,
        repayment_percent: repaymentMethod === "percent_of_net" ? Number(percent) / 100 : null,
        min_net_pay_floor: floor ? Number(floor) : null,
        max_pct_of_net: cap ? Number(cap) / 100 : null,
      });
      await refreshLoans();
      handleClose();
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to create loan");
    } finally {
      setSubmitting(false);
    }
  };

  const totalSteps = repaymentMethod === "percent_of_net" ? 3 : 4;
  const footer = (
    <>
      {step > 1 && (
        <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as Step)} disabled={submitting}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      )}
      {step === 1 && (
        <Button onClick={() => setStep(2)} disabled={!canAdvanceFrom1}>
          Continue <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      )}
      {step === 2 && (
        <Button onClick={goToPreview} disabled={!canAdvanceFrom2 || previewLoading}>
          {previewLoading ? "…" : repaymentMethod === "percent_of_net" ? "Review" : "Preview schedule"}
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      )}
      {step === 3 && (
        <Button onClick={() => setStep(4)}>
          Continue <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      )}
      {step === 4 && (
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? "Creating…" : "Create loan"}
        </Button>
      )}
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => !o && handleClose()}
      size="xl"
      title="New loan / advance"
      description={`Step ${step} of ${totalSteps} — ${STEP_LABELS[step]}`}
      headerRight={
        <Badge variant="outline" className="font-normal">
          {step}/{totalSteps}
        </Badge>
      }
      footer={footer}
    >
      <WorkflowSheetSection number={step} title={STEP_LABELS[step]}>


        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Employee</Label>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.first_name} {e.last_name} ({e.employee_number})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Loan Type</Label>
              {typesLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : activeLoanTypes.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No loan types configured. Ask an admin to set up Loan Types in Payroll → Configuration.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {activeLoanTypes.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setLoanTypeId(t.id)}
                      className={`text-left rounded-md border p-3 transition ${loanTypeId === t.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-medium text-sm">{t.name}</div>
                        <Badge variant="outline" className="text-[10px] capitalize">{t.kind.replace("_", " ")}</Badge>
                      </div>
                      {t.description && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.description}</div>}
                      <div className="text-[10px] text-muted-foreground mt-2 uppercase tracking-wider">
                        {t.default_repayment_method.replace(/_/g, " ")}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 2 && loanType && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Repayment Method</Label>
              <Select value={repaymentMethod} onValueChange={(v) => setRepaymentMethod(v as RepaymentMethod)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed_installment">Fixed installments</SelectItem>
                  <SelectItem value="fixed_amount">Fixed monthly amount</SelectItem>
                  <SelectItem value="percent_of_net">Percent of net pay</SelectItem>
                  <SelectItem value="one_off_next_payroll">One-off (next payroll)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{REPAYMENT_HELP[repaymentMethod]}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {fields
                // hide installments for one-off
                .filter((f) => !(repaymentMethod === "one_off_next_payroll" && f.key === "total_installments"))
                // hide interest if loan_type doesn't require it AND method is one-off/percent
                .filter((f) => !(f.key === "interest_rate" && !loanType.requires_interest))
                .map((f) => (
                  <div key={f.key} className="space-y-2">
                    <Label>
                      {f.label}
                      {f.required && <span className="text-destructive ml-1">*</span>}
                    </Label>
                    {f.type === "text" ? (
                      <Textarea
                        value={form[f.key] ?? ""}
                        onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                        rows={2}
                      />
                    ) : (
                      <Input
                        type={f.type}
                        value={form[f.key] ?? ""}
                        onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                      />
                    )}
                    {f.helper && <p className="text-xs text-muted-foreground">{f.helper}</p>}
                  </div>
                ))}
            </div>

            {repaymentMethod === "percent_of_net" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t pt-4">
                <div className="space-y-2">
                  <Label>Percent of Net Pay (%) <span className="text-destructive">*</span></Label>
                  <Input type="number" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10" />
                </div>
                <div className="space-y-2">
                  <Label>Min Net Pay Floor</Label>
                  <Input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="0" />
                  <p className="text-xs text-muted-foreground">Recovery skips when net would fall below this.</p>
                </div>
                <div className="space-y-2">
                  <Label>Max % of Net (cap)</Label>
                  <Input type="number" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="40" />
                </div>
              </div>
            )}

            {repaymentMethod !== "percent_of_net" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t pt-4">
                <div className="space-y-2">
                  <Label>Min Net Pay Floor</Label>
                  <Input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-2">
                  <Label>Max % of Net (cap)</Label>
                  <Input type="number" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="50" />
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <Card>
            <CardContent className="p-0 max-h-[50vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left p-2">#</th>
                    <th className="text-left p-2">Period</th>
                    <th className="text-right p-2">Scheduled</th>
                  </tr>
                </thead>
                <tbody>
                  {schedulePreview.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">{r.sequence}</td>
                      <td className="p-2">{r.due_period_start} → {r.due_period_end}</td>
                      <td className="p-2 text-right font-mono">{r.scheduled_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                  {schedulePreview.length === 0 && (
                    <tr><td colSpan={3} className="p-4 text-center text-muted-foreground text-xs">No schedule (percent-of-net)</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle2 className="h-5 w-5" /> Ready to submit
            </div>
            <div className="text-muted-foreground">
              The loan will be created in <strong>draft</strong> status. Approval generates the persistent
              repayment schedule and (if a disbursement account is configured on the loan type) enables
              the Disburse action.
            </div>
          </div>
        )}
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

const STEP_LABELS: Record<Step, string> = {
  1: "Employee & loan type",
  2: "Loan details",
  3: "Schedule preview",
  4: "Review & submit",
};

const REPAYMENT_HELP: Record<RepaymentMethod, string> = {
  fixed_installment: "Equal installment per pay period until balance is cleared.",
  fixed_amount: "Fixed amount per pay period (independent of installment count).",
  percent_of_net: "Recover a percentage of net pay each period; honors floor and cap.",
  one_off_next_payroll: "Recover the full balance on the next payroll run.",
};
