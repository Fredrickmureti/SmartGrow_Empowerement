/**
 * Payroll Control Center — operating surface for ADR-0045 batches.
 *
 * Reads totals + headcount from `v_payroll_batches` and the period strip
 * from `v_payroll_period_consolidation` (Phase 1.3). Creation collects
 * pay_schedule_id + run_type so multi-schedule tenants can produce more
 * than one batch per period (Phase 1.2). RPC errors are mapped through
 * `parseGovernanceError` upstream in the hook so SoD / permission refusals
 * surface as canonical toasts.
 */
import { useMemo, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { format, startOfMonth, endOfMonth, addMonths, subMonths } from "date-fns";
import {
  Plus, Layers, Trash2, ChevronRight, Send, CheckCircle2, FileCheck2,
  Banknote, Lock, XCircle, RotateCcw, FilePlus2, GitBranch, ChevronLeft,
  ShieldAlert, History, Link2, AlertTriangle, ShieldCheck,
} from "lucide-react";
import { BatchReadinessSnapshotPanel } from "@/components/payroll/BatchReadinessSnapshotPanel";
import { CreatePaymentBatchDialog } from "@/components/payroll/CreatePaymentBatchDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useQuery } from "@tanstack/react-query";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { supabase } from "@/integrations/supabase/client";
import {
  usePayrollRunGroups,
  type ChildRunSummary,
  type PayrollRunGroup,
} from "@/hooks/payroll/usePayrollRunGroups";
import { useSelfActionPolicy } from "@/hooks/governance/useSelfActionPolicy";
import { PayrollWorkflowStrip } from "@/components/payroll/PayrollWorkflowStrip";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  computing: "outline",
  review: "secondary",
  approved: "secondary",
  posted: "default",
  paid: "default",
  closed: "default",
  cancelled: "destructive",
  reversed: "destructive",
};

// Canonical run-type vocabulary. Matches `validate_payroll_run_type`.
const RUN_TYPES = [
  { value: "regular", label: "Regular" },
  { value: "off_cycle", label: "Off-cycle" },
  { value: "bonus", label: "Bonus" },
  { value: "thirteenth", label: "13th-month" },
  { value: "correction", label: "Correction" },
];

interface PaySchedule {
  id: string;
  name: string;
  frequency: string;
  is_active: boolean;
}

export default function PayrollControlCenter() {
  const {
    groups, childRuns, consolidation, issues, isLoading, scopeReady,
    createGroup, assignRuns, unassignRun,
    submitBatch, approveBatch, cancelBatch, markPosted, markPaid, closeBatch,
    reverseBatch, addRunToBatch,
  } = usePayrollRunGroups();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const {
    canRunPayroll, canApprovePayroll, canPostPayrollGL,
    canPayPayroll, canReversePayroll, canClosePayroll,
  } = usePermissions();
  const canManageGroups = canRunPayroll;

  // Policy-driven SoD lookup (Phase 3). Mode comes from `self_action_policy`
  // and falls back to "block" when no row exists, so the UI defaults to safe.
  const approvePolicy = useSelfActionPolicy("payroll.approve");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setCurrentUserId(data.user?.id ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  // Pay schedules for the current business — required by payroll_batch_create
  // identity tuple (org, business, pay_schedule, period, run_type).
  const paySchedulesQ = useQuery({
    queryKey: ["pay-schedules", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async (): Promise<PaySchedule[]> => {
      const { data, error } = await supabase
        .from("pay_schedules")
        .select("id, name, frequency, is_active")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PaySchedule[];
    },
  });
  const activeSchedules = useMemo(
    () => (paySchedulesQ.data ?? []).filter((s) => s.is_active),
    [paySchedulesQ.data],
  );

  const [createOpen, setCreateOpen] = useState(false);
  const today = new Date();
  const [periodAnchor, setPeriodAnchor] = useState<Date>(today);
  const [form, setForm] = useState({
    name: "",
    period_start: format(startOfMonth(today), "yyyy-MM-dd"),
    period_end: format(endOfMonth(today), "yyyy-MM-dd"),
    notes: "",
    pay_schedule_id: "" as string,
    run_type: "regular",
  });
  // Auto-select the only schedule when there's exactly one.
  useEffect(() => {
    if (!createOpen) return;
    if (!form.pay_schedule_id && activeSchedules.length === 1) {
      setForm((f) => ({ ...f, pay_schedule_id: activeSchedules[0].id }));
    }
  }, [createOpen, activeSchedules, form.pay_schedule_id]);

  const [assignFor, setAssignFor] = useState<PayrollRunGroup | null>(null);
  const [pickedRuns, setPickedRuns] = useState<Set<string>>(new Set());

  const [reasonDialog, setReasonDialog] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    minLength: number;
    onConfirm: (reason: string) => void;
  } | null>(null);
  const [reasonText, setReasonText] = useState("");

  const [addRunFor, setAddRunFor] = useState<PayrollRunGroup | null>(null);
  const [newRunForm, setNewRunForm] = useState({
    payPeriodStart: "",
    payPeriodEnd: "",
    paymentDate: "",
    runType: "regular",
    notes: "",
  });

  const [approveFor, setApproveFor] = useState<PayrollRunGroup | null>(null);
  const [approveOverride, setApproveOverride] = useState("");

  const [auditFor, setAuditFor] = useState<PayrollRunGroup | null>(null);

  const runsByGroup = useMemo(() => {
    const map = new Map<string, ChildRunSummary[]>();
    for (const r of childRuns) {
      if (!r.group_id) continue;
      const arr = map.get(r.group_id) || [];
      arr.push(r);
      map.set(r.group_id, arr);
    }
    return map;
  }, [childRuns]);

  // Per-child issue rollup (Phase 2.3). Keyed by payroll_run_id.
  const issuesByRun = useMemo(() => {
    const m = new Map<string, { blocker_count: number; warning_count: number; info_count: number }>();
    for (const i of issues) m.set(i.payroll_run_id, i);
    return m;
  }, [issues]);
  // Aggregate blocker counts up to the batch level — used to disable Submit/Approve.
  const blockersByGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const [gid, kids] of runsByGroup.entries()) {
      m.set(gid, kids.reduce((s, k) => s + (issuesByRun.get(k.id)?.blocker_count ?? 0), 0));
    }
    return m;
  }, [runsByGroup, issuesByRun]);

  // Per-child payment-batch CTA state (Phase 4.1).
  const [paymentBatchFor, setPaymentBatchFor] = useState<{
    runId: string; runNumber: string; sourceBatchId: string; sourceBatchNumber: string;
  } | null>(null);

  // Period filter: month overlap + permanent "All" toggle.
  const [showAllPeriods, setShowAllPeriods] = useState(false);
  const periodStart = useMemo(() => startOfMonth(periodAnchor), [periodAnchor]);
  const periodEnd = useMemo(() => endOfMonth(periodAnchor), [periodAnchor]);
  const visibleGroups = useMemo(() => {
    if (showAllPeriods) return groups;
    const s = format(periodStart, "yyyy-MM-dd");
    const e = format(periodEnd, "yyyy-MM-dd");
    return groups.filter((g) => g.period_start <= e && g.period_end >= s);
  }, [groups, periodStart, periodEnd, showAllPeriods]);

  // Consolidation comes from v_payroll_period_consolidation. We pick the row
  // whose period overlaps the visible month, or sum across rows when "all
  // periods" is on.
  const periodConsolidation = useMemo(() => {
    const rows = showAllPeriods
      ? consolidation
      : consolidation.filter((c) => {
          const s = format(periodStart, "yyyy-MM-dd");
          const e = format(periodEnd, "yyyy-MM-dd");
          return c.period_start <= e && c.period_end >= s;
        });
    return rows.reduce(
      (acc, r) => ({
        batches: acc.batches + Number(r.batch_count || 0),
        runs: acc.runs + Number(r.run_count || 0),
        headcount: acc.headcount + Number(r.headcount || 0),
        gross: acc.gross + Number(r.total_gross || 0),
        net: acc.net + Number(r.total_net || 0),
        employer: acc.employer + Number(r.total_employer_contributions || 0),
      }),
      { batches: 0, runs: 0, headcount: 0, gross: 0, net: 0, employer: 0 },
    );
  }, [consolidation, periodStart, periodEnd, showAllPeriods]);

  // Linked payment batches for visible batches — one query, chip per row.
  const visibleBatchIds = useMemo(() => visibleGroups.map((g) => g.id), [visibleGroups]);
  const paymentBatchesQ = useQuery({
    queryKey: ["payroll-control-center-linked-payments", visibleBatchIds],
    enabled: visibleBatchIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_payment_batches")
        .select("id, batch_number, status, total_amount, source_batch_id")
        .in("source_batch_id", visibleBatchIds as any);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; batch_number: string; status: string;
        total_amount: number; source_batch_id: string;
      }>;
    },
  });
  const paymentBatchByBatch = useMemo(() => {
    const m = new Map<string, { id: string; batch_number: string; status: string; total_amount: number }>();
    for (const p of paymentBatchesQ.data ?? []) {
      if (p.source_batch_id) m.set(p.source_batch_id, p);
    }
    return m;
  }, [paymentBatchesQ.data]);

  const ungroupedRuns = useMemo(
    () => childRuns.filter((r) => !r.group_id && !["cancelled", "deleted"].includes(r.status)),
    [childRuns],
  );
  // Ungrouped runs overlapping the visible period — surfaced so operators
  // can spot orphans and triage them into a batch (Phase 5.1).
  const ungroupedInPeriod = useMemo(() => {
    if (showAllPeriods) return ungroupedRuns;
    const s = format(periodStart, "yyyy-MM-dd");
    const e = format(periodEnd, "yyyy-MM-dd");
    return ungroupedRuns.filter((r) => r.pay_period_start <= e && r.pay_period_end >= s);
  }, [ungroupedRuns, showAllPeriods, periodStart, periodEnd]);

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (activeSchedules.length > 0 && !form.pay_schedule_id) return;
    try {
      await createGroup.mutateAsync({
        name: form.name.trim(),
        period_start: form.period_start,
        period_end: form.period_end,
        notes: form.notes.trim() || undefined,
        pay_schedule_id: form.pay_schedule_id || null,
        run_type: form.run_type || "regular",
      });
      setCreateOpen(false);
      setForm({ ...form, name: "", notes: "" });
    } catch {
      /* toast handled in hook */
    }
  };

  const submitAssign = async () => {
    if (!assignFor || pickedRuns.size === 0) return;
    await assignRuns.mutateAsync({ groupId: assignFor.id, runIds: Array.from(pickedRuns) });
    setAssignFor(null);
    setPickedRuns(new Set());
  };

  const openCancelDialog = (g: PayrollRunGroup) => {
    setReasonText("");
    setReasonDialog({
      title: `Cancel batch ${g.batch_number ?? g.name}`,
      description: "Cancelling detaches every child run and prevents further lifecycle actions. Provide a reason for the audit trail.",
      confirmLabel: "Cancel batch",
      minLength: 0,
      onConfirm: (reason) => {
        cancelBatch.mutate({ batchId: g.id, reason: reason || undefined });
        setReasonDialog(null);
      },
    });
  };

  const openReverseDialog = (g: PayrollRunGroup) => {
    setReasonText("");
    setReasonDialog({
      title: `Reverse batch ${g.batch_number ?? g.name}`,
      description: "Reversal opens a sibling correction batch tied to this one. The original batch becomes immutable. Reason (≥ 5 chars) is recorded in the audit timeline.",
      confirmLabel: "Reverse batch",
      minLength: 5,
      onConfirm: (reason) => {
        reverseBatch.mutate({ batchId: g.id, reason });
        setReasonDialog(null);
      },
    });
  };

  const openAddRunDialog = (g: PayrollRunGroup) => {
    setNewRunForm({
      payPeriodStart: g.period_start,
      payPeriodEnd: g.period_end,
      paymentDate: "",
      runType: "regular",
      notes: "",
    });
    setAddRunFor(g);
  };

  const submitAddRun = async () => {
    if (!addRunFor) return;
    await addRunToBatch.mutateAsync({
      batchId: addRunFor.id,
      payPeriodStart: newRunForm.payPeriodStart,
      payPeriodEnd: newRunForm.payPeriodEnd,
      paymentDate: newRunForm.paymentDate || undefined,
      runType: newRunForm.runType,
      notes: newRunForm.notes || undefined,
    });
    setAddRunFor(null);
  };

  if (!scopeReady) {
    return (
      <div className="space-y-4 min-w-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6" /> Payroll Control Center
          </h1>
        </div>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Select an organisation and business to view payroll batches.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6" /> Payroll Control Center
          </h1>
          <p className="text-sm text-muted-foreground">
            Operate payroll batches through their full lifecycle — draft, review, approve, post, pay, close.
            {currentBusiness?.name && (
              <span className="ml-1">Business: <span className="text-foreground font-medium">{currentBusiness.name}</span>.</span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link to="/hr/payroll/batch-register">
            <Button variant="outline" size="sm"><FileCheck2 className="h-4 w-4 mr-2" /> Batch Register</Button>
          </Link>
          {canManageGroups && (
            <>
              <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-2" /> New batch</Button>
              <WorkflowSheet
                open={createOpen}
                onOpenChange={setCreateOpen}
                title="New payroll batch"
                description="A batch is the control record for a period within one business + pay schedule. Identity = (business, pay schedule, period, run type)."
                size="xl"
                onSubmit={submitCreate}
                footer={
                  <>
                    <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button
                      type="submit"
                      disabled={
                        createGroup.isPending ||
                        (activeSchedules.length > 0 && !form.pay_schedule_id)
                      }
                    >
                      {createGroup.isPending ? "Creating…" : "Create"}
                    </Button>
                  </>
                }
              >
                <WorkflowSheetSection number={1} title="Identity" fullWidth>
                  <WorkflowField label="Name" htmlFor="name" required>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. June 2026 — Monthly Staff"
                      required
                    />
                  </WorkflowField>
                </WorkflowSheetSection>
                <WorkflowSheetGrid>
                  <WorkflowSheetSection number={2} title="Period">
                    <WorkflowField label="Period start" htmlFor="ps" required>
                      <Input
                        id="ps" type="date" value={form.period_start}
                        onChange={(e) => setForm({ ...form, period_start: e.target.value })}
                        required
                      />
                    </WorkflowField>
                    <WorkflowField label="Period end" htmlFor="pe" required>
                      <Input
                        id="pe" type="date" value={form.period_end}
                        onChange={(e) => setForm({ ...form, period_end: e.target.value })}
                        required
                      />
                    </WorkflowField>
                  </WorkflowSheetSection>
                  <WorkflowSheetSection number={3} title="Schedule & type">
                    <WorkflowField label="Pay schedule" htmlFor="psched">
                      <Select
                        value={form.pay_schedule_id || undefined}
                        onValueChange={(v) => setForm({ ...form, pay_schedule_id: v })}
                      >
                        <SelectTrigger id="psched">
                          <SelectValue placeholder={
                            activeSchedules.length === 0 ? "No active pay schedules" : "Select…"
                          } />
                        </SelectTrigger>
                        <SelectContent>
                          {activeSchedules.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name} <span className="text-muted-foreground">· {s.frequency}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </WorkflowField>
                    <WorkflowField label="Run type" htmlFor="rtype">
                      <Select
                        value={form.run_type}
                        onValueChange={(v) => setForm({ ...form, run_type: v })}
                      >
                        <SelectTrigger id="rtype">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RUN_TYPES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </WorkflowField>
                  </WorkflowSheetSection>
                </WorkflowSheetGrid>
                {activeSchedules.length === 0 && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      This business has no active pay schedule. Create one in Payroll → Settings before adding a batch.
                    </AlertDescription>
                  </Alert>
                )}
                <WorkflowSheetSection number={4} title="Notes" fullWidth>
                  <WorkflowField label="Notes" htmlFor="notes">
                    <Textarea
                      id="notes" rows={2} value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    />
                  </WorkflowField>
                </WorkflowSheetSection>
              </WorkflowSheet>
            </>
          )}
        </div>
      </div>


      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border rounded-md p-2 bg-muted/30">
            <Button size="icon" variant="ghost" onClick={() => setPeriodAnchor((d) => subMonths(d, 1))} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-sm font-medium min-w-[10ch] text-center">
              {format(periodAnchor, "MMMM yyyy")}
            </div>
            <Button size="icon" variant="ghost" onClick={() => setPeriodAnchor((d) => addMonths(d, 1))} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPeriodAnchor(new Date())}>This month</Button>
            <div className="ml-auto flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1 cursor-pointer">
                <Checkbox checked={showAllPeriods} onCheckedChange={(c) => setShowAllPeriods(!!c)} />
                <span>Show all periods</span>
              </label>
              <span className="text-muted-foreground">
                {visibleGroups.length} of {groups.length} batches
              </span>
            </div>
          </div>

          {/* Period consolidation strip — sourced from v_payroll_period_consolidation. */}
          {periodConsolidation.batches > 0 && (
            <Card>
              <CardContent className="py-3">
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-sm">
                  <Stat label="Batches" value={String(periodConsolidation.batches)} />
                  <Stat label="Runs" value={String(periodConsolidation.runs)} />
                  <Stat label="Employees" value={String(periodConsolidation.headcount)} />
                  <Stat label="Gross" value={formatCurrency(periodConsolidation.gross)} />
                  <Stat label="Net" value={formatCurrency(periodConsolidation.net)} />
                  <Stat label="Employer" value={formatCurrency(periodConsolidation.employer)} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Ungrouped runs in this period (Phase 5.1). */}
          {ungroupedInPeriod.length > 0 && (
            <Card className="border-amber-500/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {ungroupedInPeriod.length} ungrouped run{ungroupedInPeriod.length === 1 ? "" : "s"} in this period
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground mb-2">
                  These payroll runs are not attached to any batch and will not roll up into period consolidation, GL posting, or remittance reports.
                </p>
                <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {ungroupedInPeriod.slice(0, 50).map((r) => (
                    <div key={r.id} className="p-2 text-sm space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                      <Link to={`/hr/payroll/runs/${r.id}`} className="flex-1 min-w-0 flex items-center gap-2 hover:underline">
                        <ChevronRight className="h-3 w-3" />
                        <span className="font-medium">{r.payroll_number}</span>
                        <Badge variant="outline" className="text-xs">{r.status}</Badge>
                        <span className="text-muted-foreground hidden sm:inline">
                          {format(new Date(r.pay_period_start), "MMM d")} – {format(new Date(r.pay_period_end), "MMM d")}
                        </span>
                      </Link>
                      <span className="text-xs font-mono">{formatCurrency(r.total_net)}</span>
                      </div>
                      <PayrollWorkflowStrip run={r} size="xs" className="pl-5" />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {visibleGroups.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {groups.length === 0
                  ? "No payroll batches yet for this business. Create one to operate the lifecycle."
                  : "No batches in this period. Use the arrows above or toggle Show all periods."}
              </CardContent>
            </Card>
          ) : (
            <Accordion type="multiple" className="space-y-2">
              {visibleGroups.map((g) => {
                const kids = runsByGroup.get(g.id) || [];
                // Totals from the view (server-side). Falls back to client roll-up
                // for newly inserted batches the view hasn't refreshed for yet.
                const totalGross = Number(g.total_gross ?? 0)
                  || kids.reduce((s, r) => s + Number(r.total_gross || 0), 0);
                const totalNet = Number(g.total_net ?? 0)
                  || kids.reduce((s, r) => s + Number(r.total_net || 0), 0);
                const totalEmpr = Number(g.total_employer_contributions ?? 0)
                  || kids.reduce((s, r) => s + Number(r.total_employer_contributions || 0), 0);
                const headcount = Number(g.headcount ?? 0)
                  || kids.reduce((s, r) => s + (r.employee_count || 0), 0);
                const createdBy = g.created_by;
                const approvedBy = g.approved_by;
                const postedBy = g.posted_by;
                const sodCreator = !!createdBy && !!currentUserId && createdBy === currentUserId;
                const sodApprover = !!approvedBy && !!currentUserId && approvedBy === currentUserId;
                const sodPoster = !!postedBy && !!currentUserId && postedBy === currentUserId;
                const sodConflict = sodCreator;
                const linkedPayment = paymentBatchByBatch.get(g.id);
                const batchBlockers = blockersByGroup.get(g.id) ?? 0;
                return (
                  <AccordionItem key={g.id} value={g.id} className="border rounded-md">
                    <AccordionTrigger className="px-4 hover:no-underline">
                      <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-2 text-left">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate flex items-center gap-2">
                            {g.name}
                            <Badge variant="outline" className="text-[10px] uppercase">{g.run_type}</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {format(new Date(g.period_start), "MMM d")} – {format(new Date(g.period_end), "MMM d, yyyy")}
                            {" · "}{kids.length} run{kids.length === 1 ? "" : "s"} · {headcount} employee{headcount === 1 ? "" : "s"}
                          </div>
                        </div>
                        <div className="hidden sm:flex items-center gap-4 text-sm pr-4">
                          <span><span className="text-muted-foreground">Gross </span>{formatCurrency(totalGross)}</span>
                          <span><span className="text-muted-foreground">Net </span>{formatCurrency(totalNet)}</span>
                          <Badge variant={STATUS_VARIANT[g.status] ?? "secondary"}>{g.status}</Badge>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pb-4">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                        <Stat label="Gross" value={formatCurrency(totalGross)} />
                        <Stat label="Net" value={formatCurrency(totalNet)} />
                        <Stat label="Employer contrib." value={formatCurrency(totalEmpr)} />
                        <Stat label="Employees" value={String(headcount)} />
                      </div>
                      {kids.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No runs assigned yet.</p>
                      ) : (
                        <div className="border rounded-md divide-y">
                          {kids.map((r) => {
                            const iss = issuesByRun.get(r.id);
                            const blockers = iss?.blocker_count ?? 0;
                            const warns = iss?.warning_count ?? 0;
                            const showPaymentCTA = g.status === "posted" && canPayPayroll && !linkedPayment;
                            return (
                              <div key={r.id} className="p-2 text-sm space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                <Link to={`/hr/payroll/runs/${r.id}`} className="flex-1 min-w-0 flex items-center gap-2 hover:underline">
                                  <ChevronRight className="h-3 w-3" />
                                  <span className="font-medium">{r.payroll_number}</span>
                                  <Badge variant="outline" className="text-xs">{r.status}</Badge>
                                  <span className="text-muted-foreground hidden sm:inline">
                                    {format(new Date(r.pay_period_start), "MMM d")} – {format(new Date(r.pay_period_end), "MMM d")}
                                  </span>
                                </Link>
                                {blockers > 0 && (
                                  <Badge variant="destructive" className="text-[10px] gap-1" title="Blocking payroll_run_issues">
                                    <XCircle className="h-3 w-3" />{blockers}
                                  </Badge>
                                )}
                                {blockers === 0 && warns > 0 && (
                                  <Badge variant="secondary" className="text-[10px] gap-1" title="Warning payroll_run_issues">
                                    <AlertTriangle className="h-3 w-3" />{warns}
                                  </Badge>
                                )}
                                {blockers === 0 && warns === 0 && r.status !== "draft" && (
                                  <Badge variant="outline" className="text-[10px] gap-1 text-emerald-600 border-emerald-600/40">
                                    <ShieldCheck className="h-3 w-3" />ready
                                  </Badge>
                                )}
                                <span className="text-muted-foreground text-xs hidden md:inline">{r.employee_count} emp</span>
                                <span className="font-mono">{formatCurrency(r.total_net)}</span>
                                {showPaymentCTA && (
                                  <Button
                                    size="sm" variant="outline" className="h-7"
                                    onClick={() => setPaymentBatchFor({
                                      runId: r.id, runNumber: r.payroll_number,
                                      sourceBatchId: g.id, sourceBatchNumber: g.batch_number,
                                    })}
                                    title="Create payment batch for this run, linked to the payroll batch"
                                  >
                                    <Banknote className="h-3 w-3 mr-1" /> Pay
                                  </Button>
                                )}
                                {canManageGroups && (
                                  <Button size="icon" variant="ghost" onClick={() => unassignRun.mutate(r.id)} title="Remove from group">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                </div>
                                <PayrollWorkflowStrip run={r} size="xs" className="pl-5" />
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {canManageGroups && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => { setAssignFor(g); setPickedRuns(new Set()); }}>
                            <Plus className="h-3 w-3 mr-1" /> Add runs
                          </Button>
                          {(g.status === "draft" || g.status === "computing") && (
                            <Button
                              size="sm" variant="secondary"
                              onClick={() => submitBatch.mutate(g.id)}
                              disabled={submitBatch.isPending || kids.length === 0 || batchBlockers > 0}
                              title={batchBlockers > 0 ? `${batchBlockers} blocking issue${batchBlockers === 1 ? "" : "s"} on child runs — resolve before submitting.` : undefined}
                            >
                              <Send className="h-3 w-3 mr-1" /> Submit for review
                            </Button>
                          )}
                          {g.status === "review" && canApprovePayroll && (() => {
                            // Policy-derived gate: same-user approval is blocked unless
                            // policy mode is "warn" / "allow". When mode is "require_cosign"
                            // the button stays enabled but the approve dialog will require
                            // an override reason that propagates to the RPC.
                            const sodBlocked = sodConflict && !approvePolicy.canSelfAct;
                            const titleParts: string[] = [];
                            if (sodBlocked) titleParts.push(
                              approvePolicy.needsOverride
                                ? "Separation of duties: you created this batch — supply a co-signed override reason in the dialog."
                                : "Separation of duties: you created this batch and cannot approve it."
                            );
                            if (batchBlockers > 0) titleParts.push(
                              `${batchBlockers} blocking issue${batchBlockers === 1 ? "" : "s"} on child runs — resolve before approving.`
                            );
                            const disabled = approveBatch.isPending
                              || (sodBlocked && !approvePolicy.needsOverride)
                              || batchBlockers > 0;
                            return (
                              <Button
                                size="sm"
                                onClick={() => { setApproveOverride(""); setApproveFor(g); }}
                                disabled={disabled}
                                title={titleParts.join(" ") || undefined}
                              >
                                <CheckCircle2 className="h-3 w-3 mr-1" /> Approve
                              </Button>
                            );
                          })()}
                          {g.status === "approved" && canPostPayrollGL && (
                            <Button
                              size="sm"
                              onClick={() => markPosted.mutate(g.id)}
                              disabled={markPosted.isPending || sodApprover}
                              title={sodApprover ? "Separation of duties: you approved this batch and cannot post it." : undefined}
                            >
                              <FileCheck2 className="h-3 w-3 mr-1" /> Mark posted
                            </Button>
                          )}
                          {g.status === "posted" && canPayPayroll && (
                            <Button
                              size="sm"
                              onClick={() => markPaid.mutate(g.id)}
                              disabled={markPaid.isPending || sodPoster || !linkedPayment}
                              title={
                                sodPoster
                                  ? "Separation of duties: you posted this batch and cannot mark it paid."
                                  : !linkedPayment
                                    ? "No payment batch is linked to this payroll batch yet."
                                    : undefined
                              }
                            >
                              <Banknote className="h-3 w-3 mr-1" /> Mark paid
                            </Button>
                          )}
                          {g.status === "paid" && canClosePayroll && (
                            <Button size="sm" variant="secondary" onClick={() => closeBatch.mutate(g.id)} disabled={closeBatch.isPending}>
                              <Lock className="h-3 w-3 mr-1" /> Close batch
                            </Button>
                          )}
                          {["posted", "paid", "closed"].includes(g.status) && canReversePayroll && (
                            <Button size="sm" variant="outline" onClick={() => openReverseDialog(g)} disabled={reverseBatch.isPending}>
                              <RotateCcw className="h-3 w-3 mr-1" /> Reverse
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setAuditFor(g)} title="Audit & events">
                            <History className="h-3 w-3 mr-1" /> Audit
                          </Button>
                          {!["posted", "paid", "closed", "cancelled", "reversed"].includes(g.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive ml-auto"
                              onClick={() => openCancelDialog(g)}
                              disabled={cancelBatch.isPending}
                            >
                              <XCircle className="h-3 w-3 mr-1" /> Cancel
                            </Button>
                          )}
                        </div>
                      )}

                      {(sodCreator || sodApprover || sodPoster) && ["review", "approved", "posted"].includes(g.status) && (
                        <Alert variant="default" className="mt-3 border-amber-500/50">
                          <ShieldAlert className="h-4 w-4" />
                          <AlertDescription className="text-xs">
                            Separation of duties: you already acted on this batch ({sodCreator ? "created" : sodApprover ? "approved" : "posted"}) —
                            another authorised user must perform the next step.
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Readiness snapshot panel (Phase 2.1) — visible once approval has taken a snapshot. */}
                      {(g.readiness_snapshot_id || ["approved", "posted", "paid", "closed"].includes(g.status)) && (
                        <BatchReadinessSnapshotPanel snapshotId={g.readiness_snapshot_id} batchId={g.id} />
                      )}



                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                        <div>Batch #: <span className="font-mono text-foreground">{g.batch_number}</span></div>
                        {g.approved_at && <div>Approved: {format(new Date(g.approved_at), "MMM d, HH:mm")}</div>}
                        {g.posted_at && <div>Posted: {format(new Date(g.posted_at), "MMM d, HH:mm")}</div>}
                        {g.paid_at && <div>Paid: {format(new Date(g.paid_at), "MMM d, HH:mm")}</div>}
                        {g.closed_at && <div>Closed: {format(new Date(g.closed_at), "MMM d, HH:mm")}</div>}
                        {g.reversal_batch_id && (
                          <div className="flex items-center gap-1"><GitBranch className="h-3 w-3" /> Reversal sibling linked</div>
                        )}
                        {g.parent_batch_id && (
                          <div className="flex items-center gap-1"><GitBranch className="h-3 w-3" /> Child of parent batch</div>
                        )}
                        {linkedPayment && (
                          <div className="flex items-center gap-1 col-span-full">
                            <Link2 className="h-3 w-3" /> Payment batch:
                            <Link to="/hr/payroll/payments" className="font-mono text-foreground hover:underline">
                              {linkedPayment.batch_number}
                            </Link>
                            <Badge variant="outline" className="text-[10px] ml-1">{linkedPayment.status}</Badge>
                          </div>
                        )}
                      </div>

                      {canManageGroups && ["draft", "computing", "review"].includes(g.status) && (
                        <div className="mt-2">
                          <Button size="sm" variant="outline" onClick={() => openAddRunDialog(g)}>
                            <FilePlus2 className="h-3 w-3 mr-1" /> New run in batch
                          </Button>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          )}
        </>
      )}

      <WorkflowSheet
        open={!!assignFor}
        onOpenChange={(o) => { if (!o) { setAssignFor(null); setPickedRuns(new Set()); } }}
        title={`Add runs to "${assignFor?.name ?? ""}"`}
        description="Pick unassigned payroll runs to include in this batch."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => { setAssignFor(null); setPickedRuns(new Set()); }}>Cancel</Button>
            <Button onClick={submitAssign} disabled={pickedRuns.size === 0 || assignRuns.isPending}>
              {assignRuns.isPending ? "Adding…" : `Add ${pickedRuns.size} run${pickedRuns.size === 1 ? "" : "s"}`}
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Unassigned runs" fullWidth>
          <div className="max-h-80 overflow-y-auto border rounded-md divide-y">
            {ungroupedRuns.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No unassigned runs available.</p>
            ) : ungroupedRuns.map((r) => (
              <label key={r.id} className="flex items-center gap-3 p-2 cursor-pointer hover:bg-muted/50">
                <Checkbox
                  checked={pickedRuns.has(r.id)}
                  onCheckedChange={(c) => {
                    const next = new Set(pickedRuns);
                    if (c) next.add(r.id); else next.delete(r.id);
                    setPickedRuns(next);
                  }}
                />
                <div className="flex-1 text-sm min-w-0">
                  <div className="font-medium">{r.payroll_number} <Badge variant="outline" className="text-xs ml-1">{r.status}</Badge></div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(r.pay_period_start), "MMM d")} – {format(new Date(r.pay_period_end), "MMM d, yyyy")} · {r.employee_count} emp
                  </div>
                </div>
                <span className="text-xs font-mono">{formatCurrency(r.total_net)}</span>
              </label>
            ))}
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>

      <WorkflowSheet
        open={!!reasonDialog}
        onOpenChange={(o) => { if (!o) setReasonDialog(null); }}
        title={reasonDialog?.title ?? ""}
        description={reasonDialog?.description}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setReasonDialog(null)}>Cancel</Button>
            <Button
              onClick={() => reasonDialog?.onConfirm(reasonText.trim())}
              disabled={!!reasonDialog && reasonDialog.minLength > 0 && reasonText.trim().length < reasonDialog.minLength}
            >
              {reasonDialog?.confirmLabel}
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Audit reason" fullWidth>
          <WorkflowField label="Reason" htmlFor="reason">
            <Textarea id="reason" rows={3} value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="What changed and why" />
          </WorkflowField>
          {reasonDialog && reasonDialog.minLength > 0 && reasonText.trim().length < reasonDialog.minLength && (
            <p className="text-xs text-destructive">Reason must be at least {reasonDialog.minLength} characters.</p>
          )}
        </WorkflowSheetSection>
      </WorkflowSheet>

      <WorkflowSheet
        open={!!addRunFor}
        onOpenChange={(o) => { if (!o) setAddRunFor(null); }}
        title={`New run in ${addRunFor?.batch_number ?? addRunFor?.name ?? ""}`}
        description="Creates a child payroll run inheriting this batch's organisation, business, pay schedule and country."
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setAddRunFor(null)}>Cancel</Button>
            <Button onClick={submitAddRun} disabled={addRunToBatch.isPending || !newRunForm.payPeriodStart || !newRunForm.payPeriodEnd}>
              {addRunToBatch.isPending ? "Creating…" : "Create run"}
            </Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Period">
            <WorkflowField label="Pay period start" htmlFor="rps">
              <Input id="rps" type="date" value={newRunForm.payPeriodStart} onChange={(e) => setNewRunForm({ ...newRunForm, payPeriodStart: e.target.value })} />
            </WorkflowField>
            <WorkflowField label="Pay period end" htmlFor="rpe">
              <Input id="rpe" type="date" value={newRunForm.payPeriodEnd} onChange={(e) => setNewRunForm({ ...newRunForm, payPeriodEnd: e.target.value })} />
            </WorkflowField>
          </WorkflowSheetSection>
          <WorkflowSheetSection number={2} title="Payment & type">
            <WorkflowField label="Payment date" htmlFor="rpd">
              <Input id="rpd" type="date" value={newRunForm.paymentDate} onChange={(e) => setNewRunForm({ ...newRunForm, paymentDate: e.target.value })} />
            </WorkflowField>
            <WorkflowField label="Run type" htmlFor="rrt">
              <Select value={newRunForm.runType} onValueChange={(v) => setNewRunForm({ ...newRunForm, runType: v })}>
                <SelectTrigger id="rrt"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RUN_TYPES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>
        <WorkflowSheetSection number={3} title="Notes" fullWidth>
          <WorkflowField label="Notes" htmlFor="rnotes">
            <Textarea id="rnotes" rows={2} value={newRunForm.notes} onChange={(e) => setNewRunForm({ ...newRunForm, notes: e.target.value })} />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>

      <WorkflowSheet
        open={!!approveFor}
        onOpenChange={(o) => { if (!o) setApproveFor(null); }}
        title={`Approve ${approveFor?.batch_number ?? approveFor?.name ?? ""}`}
        description="Approval evaluates payroll readiness for the period and snapshots the result. If readiness fails, supply an override reason (≥ 5 chars) to proceed."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setApproveFor(null)}>Cancel</Button>
            <Button
              onClick={async () => {
                if (!approveFor) return;
                try {
                  await approveBatch.mutateAsync({ batchId: approveFor.id, overrideReason: approveOverride.trim() || undefined });
                  setApproveFor(null);
                } catch { /* toast handled in hook */ }
              }}
              disabled={approveBatch.isPending}
            >
              {approveBatch.isPending ? "Approving…" : "Approve"}
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Override" fullWidth>
          <WorkflowField label="Override reason (only required if readiness fails)" htmlFor="override">
            <Textarea id="override" rows={2} value={approveOverride} onChange={(e) => setApproveOverride(e.target.value)} placeholder="e.g. statutory rule deferred to next cycle per finance" />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>

      <BatchAuditDrawer batch={auditFor} onClose={() => setAuditFor(null)} />

      {/* Phase 4.1 — per-child "Create payment batch" CTA (threads sourceBatchId so payroll_batch_mark_paid becomes reachable). */}
      {paymentBatchFor && (
        <CreatePaymentBatchDialog
          open={!!paymentBatchFor}
          onOpenChange={(o) => { if (!o) setPaymentBatchFor(null); }}
          payrollRunId={paymentBatchFor.runId}
          payrollNumber={paymentBatchFor.runNumber}
          sourceBatchId={paymentBatchFor.sourceBatchId}
          sourceBatchNumber={paymentBatchFor.sourceBatchNumber}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent className="pt-0"><div className="text-lg font-semibold">{value}</div></CardContent>
    </Card>
  );
}

/**
 * Audit & events side-sheet — unified timeline across:
 *   - business_event_outbox  (lifecycle events emitted by the batch RPCs)
 *   - audit_logs             (generic audit rows tagged to this batch)
 *   - approval_history       (approval-request decisions referencing the batch)
 * Read-only; merged client-side and sorted desc by timestamp.
 */
function BatchAuditDrawer({ batch, onClose }: { batch: PayrollRunGroup | null; onClose: () => void }) {
  const eventsQ = useQuery({
    queryKey: ["payroll-batch-audit-timeline", batch?.id],
    enabled: !!batch?.id,
    queryFn: async () => {
      const approvalReqs = await supabase
        .from("approval_requests")
        .select("id")
        .eq("entity_type", "payroll_run_group")
        .eq("entity_id", batch!.id);
      const requestIds = (approvalReqs.data ?? []).map((r) => r.id);

      const [outbox, audits, approvals] = await Promise.all([
        supabase
          .from("business_event_outbox")
          .select("id, event_type, created_at, payload, status")
          .eq("source_doc_type", "payroll_batch")
          .eq("source_doc_id", batch!.id)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("audit_logs")
          .select("id, action, created_at, new_values, user_id, entity_type")
          .eq("entity_type", "payroll_run_group")
          .eq("entity_id", batch!.id)
          .order("created_at", { ascending: false })
          .limit(200),
        requestIds.length
          ? supabase
              .from("approval_history")
              .select("id, action, approved_at, comments, approved_by, request_id")
              .in("request_id", requestIds)
              .order("approved_at", { ascending: false })
              .limit(200)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const rows: Array<{ id: string; source: string; type: string; created_at: string; payload: any; status?: string }> = [];
      for (const e of outbox.data ?? []) rows.push({ id: `o-${e.id}`, source: "outbox", type: e.event_type, created_at: e.created_at, payload: e.payload, status: e.status });
      for (const a of audits.data ?? []) rows.push({ id: `a-${a.id}`, source: "audit", type: a.action, created_at: a.created_at, payload: a.new_values });
      for (const ap of (approvals.data ?? []) as any[]) rows.push({ id: `p-${ap.id}`, source: "approval", type: ap.action, created_at: ap.approved_at, payload: { comments: ap.comments } });
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return rows;
    },
  });
  return (
    <Sheet open={!!batch} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Audit timeline · {batch?.batch_number ?? batch?.name}</SheetTitle>
          <SheetDescription>Merged lifecycle, audit, and approval events for this batch.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          {eventsQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {!eventsQ.isLoading && (eventsQ.data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground">No events recorded for this batch yet.</div>
          )}
          {(eventsQ.data ?? []).map((ev) => (
            <div key={ev.id} className="border rounded-md p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono truncate">{ev.type}</span>
                <Badge variant="outline" className="text-[10px] uppercase shrink-0">{ev.source}</Badge>
                {ev.status && <Badge variant="outline" className="text-[10px]">{ev.status}</Badge>}
              </div>
              <div className="text-muted-foreground mt-0.5">
                {format(new Date(ev.created_at), "MMM d, yyyy HH:mm:ss")}
              </div>
              {ev.payload && (
                <pre className="mt-1 text-[10px] bg-muted/40 rounded p-1 overflow-x-auto">
{JSON.stringify(ev.payload, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
