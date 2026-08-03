/**
 * Payroll Runs page — list + create + filter.
 *
 * Lifts the bulk of the legacy Payroll.tsx monolith here. Same dialogs,
 * same hook, but now lives in its own route under /hr/payroll/runs so the
 * Overview/Readiness/Payslips/Reports pages can stand on their own.
 */
import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { usePayroll, PayrollRun, Payslip, VariableEarningsInput as VEInput } from "@/hooks/usePayroll";
import { useEmployees } from "@/hooks/useEmployees";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { usePayrollGL } from "@/hooks/usePayrollGL";
import { usePermissions } from "@/hooks/usePermissions";
import { usePayrollReadiness } from "@/hooks/payroll/usePayrollReadiness";
import { PayrollRunList } from "@/components/payroll/PayrollRunList";
import { PayrollJobPanel } from "@/components/payroll/PayrollJobPanel";
import { PayrollRunDetailsDialog } from "@/components/payroll/PayrollRunDetailsDialog";
import { CreatePayrollDialog } from "@/components/payroll/CreatePayrollDialog";
import { CreatePaymentBatchDialog } from "@/components/payroll/CreatePaymentBatchDialog";
import { PayrollPreviewDialog } from "@/components/payroll/PayrollPreviewDialog";
import { ReversePayrollDialog } from "@/components/payroll/ReversePayrollDialog";
import { PayrollSetupGate } from "@/components/payroll/PayrollSetupGate";
import { PayrollSetupGuideDialog } from "@/components/payroll/PayrollSetupGuideDialog";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import {
  usePendingPayrollInputs,
  mergePendingIntoVariableEarnings,
  consumePendingPayrollInputs,
} from "@/hooks/payroll/usePendingPayrollInputs";

export default function PayrollRuns() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { payrollRuns, isLoading, createPayrollRun, previewPayrollRun, approvePayrollRun, fetchPayslips, deletePayrollRun, refreshPayrollRuns } = usePayroll();
  const { activeEmployees } = useEmployees();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { isReady: currencyReady } = useCurrency();
  const { postPayrollToGL } = usePayrollGL();
  const { canRunPayroll } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const {
    isReady: payrollReady,
    hasEvaluation: readinessEvaluated,
    orgBlockers,
    businessBlockers,
    employeeBlockers,
  } = usePayrollReadiness({ employeeIds: null });
  const readinessBlockers = [...orgBlockers, ...businessBlockers, ...employeeBlockers];
  const setupBlocked = readinessEvaluated && !payrollReady;

  const [showDialog, setShowDialog] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedRun, setSelectedRun] = useState<PayrollRun | null>(null);
  const [selectedPayslips, setSelectedPayslips] = useState<Payslip[]>([]);
  const [isLoadingPayslips, setIsLoadingPayslips] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [variableEarnings, setVariableEarnings] = useState<VEInput[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  // Empty set means "all active employees"; non-empty means an explicit subset.
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<string>>(new Set());
  const [setupGuide, setSetupGuide] = useState<{
    open: boolean;
    reasons: string[];
    runtimeBlockers: import("@/hooks/payroll/usePayrollReadiness").PayrollReadinessBlocker[] | null;
  }>({ open: false, reasons: [], runtimeBlockers: null });
  const [paymentBatchRun, setPaymentBatchRun] = useState<PayrollRun | null>(null);
  const [postingRunId, setPostingRunId] = useState<string | null>(null);
  const [reverseRun, setReverseRun] = useState<PayrollRun | null>(null);
  const [runType, setRunType] = useState<string>("regular");
  const [parentRunId, setParentRunId] = useState<string | null>(null);
  // Per-employee proration overrides for this run draft. Map<employee_id, {reason}>
  // Cleared whenever the preview dialog is closed or a fresh run is started.
  const [prorationOverrides, setProrationOverrides] = useState<Record<string, { full_period: boolean; reason: string }>>({});
  const [recovery, setRecovery] = useState<{
    open: boolean;
    existingRunId: string;
    existingNumber: string;
    existingStatus: string;
  } | null>(null);

  useEffect(() => {
    if (searchParams.get("action") === "create") {
      setShowDialog(true);
      // Honour deep-link prefill from /hr/payroll/readiness so the dialog
      // opens already scoped to the period + ready employees the user just
      // verified.
      const ps = searchParams.get("period_start");
      const pe = searchParams.get("period_end");
      const empCsv = searchParams.get("employee_ids");
      if (ps && pe) {
        setFormData((prev) => ({ ...prev, pay_period_start: ps, pay_period_end: pe }));
      }
      if (empCsv) {
        const ids = empCsv.split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length) setSelectedEmployeeIds(new Set(ids));
      }
      // Strip the params so closing the dialog doesn't immediately re-open it.
      const next = new URLSearchParams(searchParams);
      ["action", "period_start", "period_end", "period_id", "employee_ids"].forEach((k) => next.delete(k));
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Phase 3 · Realtime job-status subscription.
  // The HTTP response from compute-payroll is no longer the source of truth
  // for whether payroll ran (a transport drop can hide a successful run).
  // Subscribe to `payroll_run_jobs` for this org — when the server marks a
  // job succeeded or failed we refresh the runs list and notify the user,
  // regardless of whether their invoke() call ever returned.
  useEffect(() => {
    const orgId = currentOrg?.id;
    if (!orgId) return;
    const channel = supabase
      .channel(`payroll_run_jobs:${orgId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "payroll_run_jobs",
          filter: `organization_id=eq.${orgId}`,
        },
        (payload) => {
          const row = payload.new as {
            status?: string;
            error_message?: string | null;
            payroll_run_id?: string | null;
          };
          if (row?.status === "succeeded") {
            void refreshPayrollRuns?.();
            toast({
              title: "Payroll finished on the server",
              description: "The run has been recorded. Refreshing the list.",
            });
          } else if (row?.status === "failed") {
            void refreshPayrollRuns?.();
            toast({
              title: "Payroll engine reported a failure",
              description: row.error_message || "Check the runs list for details.",
              variant: "destructive",
            });
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentOrg?.id, refreshPayrollRuns, toast]);

  // Default to current month — last month was confusing when employees only
  // have contracts that start this month (they would be silently filtered).
  const today = new Date();
  const [formData, setFormData] = useState({
    pay_period_start: format(startOfMonth(today), "yyyy-MM-dd"),
    pay_period_end: format(endOfMonth(today), "yyyy-MM-dd"),
    payment_date: format(new Date(), "yyyy-MM-dd"),
  });

  /**
   * Classify an error from the payroll edge function.
   *  - "setup"    → opens PayrollSetupGuideDialog. Prefers structured
   *                 `blockers` from the edge function payload (412
   *                 SETUP_REQUIRED) over English-string regex parsing.
   *  - "internal" → schema/PostgREST/edge crash; show "report this" toast
   *  - "user"     → plain validation toast
   */
  const classifyPayrollError = (err: any): {
    kind: "setup" | "internal" | "user" | "offline" | "transport";
    msg: string;
    reasons: string[];
    runtimeBlockers: import("@/hooks/payroll/usePayrollReadiness").PayrollReadinessBlocker[] | null;
  } => {
    const msg: string = err?.message || String(err) || "";
    const payload = err?.payload as any;
    // Split transport failures. OFFLINE = browser reports no connectivity
    // (safe to say "no changes were saved"). TRANSPORT_FAILED = the browser
    // is online but the edge runtime dropped mid-invoke — payroll may have
    // committed partial state; the UI MUST refetch, not retry blindly.
    if (
      err?.code === "OFFLINE" ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    ) {
      return { kind: "offline", msg, reasons: [], runtimeBlockers: null };
    }
    if (
      err?.code === "TRANSPORT_FAILED" ||
      err?.name === "FunctionsFetchError" ||
      /failed to send a request|failed to fetch|load failed|network ?error/i.test(msg)
    ) {
      return { kind: "transport", msg, reasons: [], runtimeBlockers: null };
    }
    // Preferred path: edge function returned 412 SETUP_REQUIRED with
    // structured blockers — surface them verbatim, no regex.
    if (err?.code === "SETUP_REQUIRED" || payload?.code === "SETUP_REQUIRED") {
      const blockers = Array.isArray(payload?.blockers) ? payload.blockers : [];
      return { kind: "setup", msg, reasons: [], runtimeBlockers: blockers };
    }
    const isInternal = /PGRST\d{3}|schema cache|column .* does not exist|function .* does not exist|relation .* does not exist|Internal Server Error|non-2xx|500/i.test(msg);
    if (isInternal) return { kind: "internal", msg, reasons: [], runtimeBlockers: null };
    // Legacy SETUP_REQUIRED fallback (raised by assert_payroll_ready when an
    // older caller path bypasses the JSON variant).
    const isSetup = /SETUP_REQUIRED|setup is required|setup required|missing|not configured|localization|statutory|mapping|structure|schedule/i.test(msg);
    if (isSetup) {
      const stripped = msg.replace(/^[^:]*:\s*/, "");
      const reasons = stripped.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
      return { kind: "setup", msg, reasons: reasons.length ? reasons : [msg], runtimeBlockers: null };
    }
    return { kind: "user", msg, reasons: [], runtimeBlockers: null };
  };

  const handlePayrollError = (title: string, err: any) => {
    const c = classifyPayrollError(err);
    if (c.kind === "offline") {
      toast({
        title: "Connection lost — payroll not saved",
        description:
          "Your internet connection dropped while running payroll, so we couldn't reach the server. No changes were saved — reconnect and try again.",
        variant: "destructive",
      });
    } else if (c.kind === "transport") {
      // Accept endpoint is fast (<2s) and hands off to a background worker.
      // A transport failure here means the ACCEPT call itself was dropped —
      // the job row may or may not exist. The PayrollJobPanel below reads
      // authoritative state from `payroll_run_jobs`; if a job with the same
      // idempotency key was created, it will surface there and continue.
      console.error("[Payroll accept transport failure]", err);
      void refreshPayrollRuns?.();
      toast({
        title: "Couldn't reach the payroll service",
        description:
          "Check the panel below the runs list — if a payroll job appears there, it is running on the server and will complete on its own. If nothing appears, try again in a moment; the server prevents duplicate payslips via the idempotency key.",
        variant: "destructive",
      });
    } else if (c.kind === "setup") {
      setSetupGuide({ open: true, reasons: c.reasons, runtimeBlockers: c.runtimeBlockers });
    } else if (c.kind === "internal") {
      console.error("[Payroll internal error]", err);
      toast({
        title: "Internal payroll error",
        description: "Something went wrong inside the payroll engine. Please report this with the timestamp — accountants should never see raw schema errors.",
        variant: "destructive",
      });
    } else {
      toast({ title, description: c.msg, variant: "destructive" });
    }
  };

  // Resolve the actual employee list for the run from the picker selection.
  const employeesForRun = (() => {
    if (selectedEmployeeIds.size === 0) return activeEmployees;
    return activeEmployees.filter((e) => selectedEmployeeIds.has(e.id));
  })();

  const candidateParentRuns = payrollRuns
    .filter(r =>
      r.pay_period_start === formData.pay_period_start &&
      r.pay_period_end === formData.pay_period_end &&
      ["posted", "approved", "paid"].includes(String(r.status)),
    )
    .map(r => ({ id: r.id, payroll_number: r.payroll_number, status: String(r.status) }));

  // The existing regular run (if any) for the picked period — surfaced in the
  // dialog so the accountant sees the conflict BEFORE submitting and can
  // switch to off-cycle in one click (Odoo / QuickBooks parity).
  const existingRegularRun = payrollRuns.find(r =>
    r.pay_period_start === formData.pay_period_start &&
    r.pay_period_end === formData.pay_period_end &&
    String((r as any).run_type ?? "regular") === "regular" &&
    String(r.status) !== "deleted" &&
    String(r.status) !== "cancelled",
  );
  const existingRegularSummary = existingRegularRun
    ? { id: existingRegularRun.id, payroll_number: existingRegularRun.payroll_number, status: String(existingRegularRun.status) }
    : null;

  const handlePreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeEmployees.length) {
      toast({ title: "No employees", description: "Add active employees first.", variant: "destructive" });
      return;
    }
    if (!employeesForRun.length) {
      toast({ title: "Select at least one employee", description: "The employee picker is empty.", variant: "destructive" });
      return;
    }
    if ((runType === "correction" || runType === "supplemental") && !parentRunId) {
      toast({ title: "Parent run required", description: `${runType} runs must point at a posted run in the same period.`, variant: "destructive" });
      return;
    }
    setIsLoadingPreview(true);
    setShowPreview(true);
    setShowDialog(false);
    try {
      const data = await previewPayrollRun(
        formData.pay_period_start, formData.pay_period_end, employeesForRun,
        currentBusiness?.country || null, variableEarnings,
        { run_type: runType, parent_run_id: parentRunId },
        prorationOverrides,
      );
      setPreviewData(data);
    } catch (err: any) {
      setShowPreview(false);
      handlePayrollError("Preview failed", err);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  /**
   * Re-run the dry-run preview with an updated proration-override map.
   * Used by PayrollPreviewDialog when the accountant overrides a prorated
   * employee to the full period (e.g. "hired late in the month but policy
   * pays first month in full").
   */
  const handleOverrideProration = async (
    employeeId: string,
    reason: string,
  ) => {
    const next = { ...prorationOverrides, [employeeId]: { full_period: true, reason } };
    setProrationOverrides(next);
    setIsLoadingPreview(true);
    try {
      const data = await previewPayrollRun(
        formData.pay_period_start, formData.pay_period_end, employeesForRun,
        currentBusiness?.country || null, variableEarnings,
        { run_type: runType, parent_run_id: parentRunId },
        next,
      );
      setPreviewData(data);
    } catch (err: any) {
      handlePayrollError("Preview failed", err);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleClearOverride = async (employeeId: string) => {
    const next = { ...prorationOverrides };
    delete next[employeeId];
    setProrationOverrides(next);
    setIsLoadingPreview(true);
    try {
      const data = await previewPayrollRun(
        formData.pay_period_start, formData.pay_period_end, employeesForRun,
        currentBusiness?.country || null, variableEarnings,
        { run_type: runType, parent_run_id: parentRunId },
        next,
      );
      setPreviewData(data);
    } catch (err: any) {
      handlePayrollError("Preview failed", err);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      const result = await createPayrollRun(
        formData.pay_period_start, formData.pay_period_end, employeesForRun,
        undefined, undefined, currentBusiness?.country || null,
        variableEarnings, formData.payment_date,
        { run_type: runType, parent_run_id: parentRunId },
        prorationOverrides,
      );
      // The accept endpoint returns 202 and hands off to a background
      // worker. The runs list + PayrollJobPanel take over from here —
      // do not report success or failure based on this promise.
      if ((result as any)?.__async) {
        toast({
          title: "Payroll queued",
          description: "The engine is running in the background. Progress is shown below the runs list; you can safely leave this page.",
        });
      } else {
        toast({ title: "Payroll run created" });
      }
      setShowPreview(false); setPreviewData(null); setVariableEarnings([]);
      setRunType("regular"); setParentRunId(null); setProrationOverrides({});
    } catch (err: any) {
      setShowPreview(false);
      if (err?.code === "REGULAR_RUN_EXISTS" && err?.payload) {
        setRecovery({
          open: true,
          existingRunId: err.payload.existing_run_id,
          existingNumber: err.payload.existing_payroll_number,
          existingStatus: err.payload.existing_status,
        });
      } else {
        handlePayrollError("Could not create payroll run", err);
      }
    } finally {
      setIsConfirming(false);
    }
  };

  const handleViewDetails = async (run: PayrollRun) => {
    setSelectedRun(run); setShowDetails(true); setSelectedPayslips([]); setIsLoadingPayslips(true);
    try { setSelectedPayslips(await fetchPayslips(run.id)); } finally { setIsLoadingPayslips(false); }
  };
  const handleApprove = async (run: PayrollRun) => { try { await approvePayrollRun(run.id); toast({ title: "Approved" }); } catch (e: any) { handlePayrollError("Approval failed", e); } };
  const handlePostToGL = async (run: PayrollRun) => {
    if (postingRunId) return; // ignore double-clicks while a run is in flight
    setPostingRunId(run.id);
    try {
      await postPayrollToGL(run);
      // Refresh anything downstream of a successful post — including the
      // liability ledger, statutory return reconciliation, and Finance JE list
      // so dependent surfaces don't show stale data until a manual refresh.
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll-gl-readiness"] });
      qc.invalidateQueries({ queryKey: ["app-setup-status"] });
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      qc.invalidateQueries({ queryKey: ["payroll-liabilities"] });
      qc.invalidateQueries({ queryKey: ["payroll-return-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll-payments"] });
    } catch (e: any) {
      handlePayrollError("GL posting failed", e);
    } finally {
      setPostingRunId(null);
    }
  };
  const handleMarkPaid = (run: PayrollRun) => { setPaymentBatchRun(run); };
  const handleDelete = async (run: PayrollRun) => { try { await deletePayrollRun(run.id); } catch (e: any) { handlePayrollError("Delete failed", e); } };

  const filtered = payrollRuns.filter((r) => {
    const matchesSearch = r.payroll_number.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || r.status === statusFilter;
    return matchesSearch && matchesStatus;
  });
  const totalMonthlyPayroll = activeEmployees.reduce((s, e) => s + ((e as any).basic_salary || 0), 0);

  const getExport = useCallback((): ExportConfig => ({
    title: "Payroll Runs Report",
    companyName: currentOrg?.name || undefined,
    dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
    columns: [
      { key: "payroll_number", header: "Payroll #", width: 15 },
      { key: "period", header: "Pay Period", width: 25 },
      { key: "employee_count", header: "Employees", format: "number", align: "right" },
      { key: "total_gross", header: "Gross Pay", format: "currency", align: "right" },
      { key: "total_net", header: "Net Pay", format: "currency", align: "right" },
      { key: "status", header: "Status", width: 12 },
    ],
    rows: filtered.map((run) => ({
      payroll_number: run.payroll_number,
      period: `${format(new Date(run.pay_period_start), "MMM d")} - ${format(new Date(run.pay_period_end), "MMM d, yyyy")}`,
      employee_count: run.employee_count,
      total_gross: run.total_gross,
      total_net: run.total_net,
      status: run.status,
    })),
    organizationId: currentOrg?.id,
    currency: currentBusiness?.base_currency || undefined,
  }), [filtered, currentOrg, currentBusiness]);

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Payroll Runs</h1>
          <p className="text-sm text-muted-foreground">Create, calculate, approve, post, and pay payroll runs.</p>
        </div>
        {canRunPayroll && (
          <Button onClick={() => setShowDialog(true)} disabled={setupBlocked} title={setupBlocked ? "Payroll setup is incomplete" : undefined} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" /> New Payroll Run
          </Button>
        )}
      </div>

      {setupBlocked && <PayrollSetupGate><></></PayrollSetupGate>}

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search payroll runs..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="posted">Posted to GL</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <ReportExportButtons getExportConfig={getExport} formats={["excel", "csv", "pdf"]} compact />
        </div>
      </div>

      <PayrollRunList
        runs={filtered}
        isLoading={isLoading}
        currencyReady={currencyReady}
        onViewDetails={handleViewDetails}
        onApprove={handleApprove}
        onPostToGL={handlePostToGL}
        onMarkPaid={handleMarkPaid}
        onDelete={handleDelete}
        onReverse={setReverseRun}
        postingRunId={postingRunId}
      />

      {/* Authoritative execution state — visible whenever a payroll job is
          queued, running, or recently completed. Survives page refresh. */}
      <div className="mt-4">
        <PayrollJobPanel />
      </div>

      <CreatePayrollDialog
        open={showDialog} onOpenChange={setShowDialog}
        employees={activeEmployees}
        totalMonthlyPayroll={totalMonthlyPayroll}
        formData={formData} onFormDataChange={setFormData}
        variableEarnings={variableEarnings} onVariableEarningsChange={setVariableEarnings}
        onPreview={handlePreview} isLoadingPreview={isLoadingPreview}
        selectedEmployeeIds={selectedEmployeeIds}
        onSelectedEmployeeIdsChange={setSelectedEmployeeIds}
        runType={runType} onRunTypeChange={setRunType}
        parentRunId={parentRunId} onParentRunIdChange={setParentRunId}
        candidateParentRuns={candidateParentRuns}
        existingRegularRun={existingRegularSummary}
      />
      <PayrollRunDetailsDialog
        open={showDetails} onOpenChange={setShowDetails}
        run={selectedRun} payslips={selectedPayslips}
        isLoadingPayslips={isLoadingPayslips}
        onApprove={handleApprove} onPostToGL={handlePostToGL} onMarkPaid={handleMarkPaid}
        onDelete={handleDelete}
        onReverse={setReverseRun}
        postingRunId={postingRunId}
      />
      <ReversePayrollDialog
        open={!!reverseRun}
        onOpenChange={(o) => { if (!o) setReverseRun(null); }}
        run={reverseRun}
        organizationId={currentOrg?.id ?? null}
        businessId={currentBusiness?.id ?? null}
        onReversed={() => {
          // usePayroll keeps runs in local state (not React Query), so the
          // dialog's queryClient.invalidateQueries(["payroll-runs"]) does NOT
          // refetch this list. Explicitly refetch so the Reverse button
          // disappears immediately without a hard reload.
          refreshPayrollRuns();
          setShowDetails(false);
          setSelectedRun(null);
        }}
      />
      <PayrollPreviewDialog
        open={showPreview} onOpenChange={setShowPreview}
        previewData={previewData} isLoading={isLoadingPreview}
        onConfirm={handleConfirm} isConfirming={isConfirming}
        periodLabel={`${formData.pay_period_start} to ${formData.pay_period_end}`}
        prorationOverrides={prorationOverrides}
        onOverrideProration={handleOverrideProration}
        onClearOverride={handleClearOverride}
      />

      <PayrollSetupGuideDialog
        open={setupGuide.open}
        onOpenChange={(o) => setSetupGuide(s => ({ ...s, open: o }))}
        organizationId={currentOrg?.id ?? null}
        businessId={currentBusiness?.id ?? null}
        countryCode={(currentBusiness as any)?.country || (currentOrg as any)?.country_code || null}
        countryLabel={(currentBusiness as any)?.country || null}
        blockers={setupGuide.runtimeBlockers ?? readinessBlockers}
        reasons={setupGuide.reasons}
        onInstalled={() => setSetupGuide({ open: false, reasons: [], runtimeBlockers: null })}
      />

      {paymentBatchRun && (
        <CreatePaymentBatchDialog
          open={!!paymentBatchRun}
          onOpenChange={(o) => { if (!o) setPaymentBatchRun(null); }}
          payrollRunId={paymentBatchRun.id}
          payrollNumber={paymentBatchRun.payroll_number}
        />
      )}

      <p className="text-xs text-muted-foreground">
        Looking for analytics? See <Link to="/hr/payroll/reports" className="underline">Reports</Link>.
      </p>

      <AlertDialog open={!!recovery?.open} onOpenChange={(o) => { if (!o) setRecovery(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regular run already exists for this period</AlertDialogTitle>
            <AlertDialogDescription>
              {recovery?.existingNumber} ({recovery?.existingStatus}) is already the regular run for{" "}
              {formData.pay_period_start} – {formData.pay_period_end}. Pick how you want to handle the new payroll:
              <ul className="mt-3 ml-4 list-disc space-y-1 text-sm">
                <li><b>Off-cycle run</b> — pay a late hire, bonus, or one-off without touching the regular run.</li>
                <li><b>Correction run</b> — post a signed delta against {recovery?.existingNumber}. Original stays intact for audit.</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRunType("off_cycle");
                setParentRunId(null);
                setRecovery(null);
                setShowDialog(true);
              }}
            >
              Create off-cycle run
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setRunType("correction");
                setParentRunId(recovery?.existingRunId ?? null);
                setRecovery(null);
                setShowDialog(true);
              }}
            >
              Create correction run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
