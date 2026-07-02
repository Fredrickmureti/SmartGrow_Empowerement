/**
 * Loan Skip Overrides — operational console (maker-checker).
 *
 * Lives at /hr/payroll/loan-skip-overrides.
 *
 * Records the full lifecycle of a payroll-run loan skip exception:
 *   pending → approved | rejected | cancelled → consumed | expired
 *
 * The compute-payroll engine only honours `approved` rows. Approvals enforce
 * segregation of duties server-side (a different user from the maker), and
 * consumption applies the loan-type's `schedule_adjustment_on_skip` policy.
 */
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import {
  useLoanSkipOverrides,
  type LoanSkipOverrideStatus,
} from "@/hooks/useLoanSkipOverrides";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Ban, Check, Plus, Trash2, X, ShieldAlert, ExternalLink, Clock, CheckCircle2, Layers, DollarSign, Users } from "lucide-react";

interface PayrollRunRow {
  id: string;
  payroll_number: string | null;
  status: string;
  pay_period_start: string;
  pay_period_end: string;
}

interface LoanRow {
  id: string;
  employee_id: string;
  loan_number: string | null;
  principal_amount: number;
  outstanding_balance: number | null;
  status: string;
}

interface ScheduleRow {
  id: string;
  loan_id: string;
  sequence: number;
  due_period_end: string;
  scheduled_amount: number;
  status: string;
}

interface LoanTypeRow {
  id: string;
  name: string | null;
  schedule_adjustment_on_skip: string | null;
  min_gap_between_skips_days: number | null;
  max_skips_per_loan: number | null;
}

const STATUS_VARIANT: Record<LoanSkipOverrideStatus, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
  cancelled: "outline",
  expired: "outline",
  consumed: "default",
};

const REASON_CATEGORIES = [
  { value: "unpaid_leave", label: "Unpaid leave" },
  { value: "suspension", label: "Suspension" },
  { value: "hardship", label: "Financial hardship" },
  { value: "dispute", label: "Dispute / under review" },
  { value: "admin_error", label: "Admin error correction" },
  { value: "other", label: "Other (explain in reason)" },
];

function KpiTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded-md border bg-card p-3 flex items-start gap-2">
      <div className="text-muted-foreground mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

export default function LoanSkipOverridesPage() {
  const { currentOrg } = useOrganization();
  const [runId, setRunId] = useState<string>("__all__");
  const [tab, setTab] = useState<"pending" | "approved" | "history">("pending");
  const [sourceFilter, setSourceFilter] = useState<string>("__all__");

  const { data: runs = [] } = useQuery({
    queryKey: ["draft-payroll-runs", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("payroll_runs")
        .select("id,payroll_number,status,pay_period_start,pay_period_end")
        .eq("organization_id", currentOrg.id)
        .in("status", ["draft", "computing", "computed", "processing"])
        .order("pay_period_start", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as PayrollRunRow[];
    },
    enabled: !!currentOrg?.id,
  });

  const {
    overrides, isLoading,
    createOverride, approveOverride, rejectOverride, cancelOverride, deleteOverride,
  } = useLoanSkipOverrides(runId === "__all__" ? undefined : runId);

  const { data: loans = [] } = useQuery({
    queryKey: ["active-loans", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("employee_loans")
        .select("id,employee_id,loan_number,principal_amount,outstanding_balance,status,loan_type_id")
        .eq("organization_id", currentOrg.id)
        .eq("status", "active")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as (LoanRow & { loan_type_id: string | null })[];
    },
    enabled: !!currentOrg?.id,
  });

  // Loan types (for impact strategy display + KPI grouping).
  const { data: loanTypes = [] } = useQuery({
    queryKey: ["loan-types-skip-meta", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("loan_types")
        .select("id,name,schedule_adjustment_on_skip,min_gap_between_skips_days,max_skips_per_loan")
        .eq("organization_id", currentOrg.id);
      if (error) throw error;
      return (data ?? []) as LoanTypeRow[];
    },
    enabled: !!currentOrg?.id,
  });

  // Schedule rows touched by any visible override (for amount + KPI dollar impact).
  const overrideScheduleIds = useMemo(
    () => Array.from(new Set(overrides.map((o) => o.schedule_id))),
    [overrides],
  );
  const { data: overrideSchedules = [] } = useQuery({
    queryKey: ["override-schedules", overrideScheduleIds],
    queryFn: async () => {
      if (overrideScheduleIds.length === 0) return [];
      const { data, error } = await supabase
        .from("loan_repayment_schedule")
        .select("id,loan_id,sequence,due_period_end,scheduled_amount,status")
        .in("id", overrideScheduleIds);
      if (error) throw error;
      return (data ?? []) as ScheduleRow[];
    },
    enabled: overrideScheduleIds.length > 0,
  });

  const scheduleById = useMemo(() => {
    const m = new Map<string, ScheduleRow>();
    for (const s of overrideSchedules) m.set(s.id, s);
    return m;
  }, [overrideSchedules]);

  const loanById = useMemo(() => {
    const m = new Map<string, LoanRow & { loan_type_id: string | null }>();
    for (const l of loans) m.set(l.id, l);
    return m;
  }, [loans]);

  const loanTypeById = useMemo(() => {
    const m = new Map<string, LoanTypeRow>();
    for (const t of loanTypes) m.set(t.id, t);
    return m;
  }, [loanTypes]);

  const [open, setOpen] = useState(false);
  const [loanId, setLoanId] = useState("");
  const [scheduleId, setScheduleId] = useState("");
  const [reason, setReason] = useState("");
  const [reasonCategory, setReasonCategory] = useState<string>("unpaid_leave");
  const [evidenceUrl, setEvidenceUrl] = useState("");

  const { data: schedules = [] } = useQuery({
    queryKey: ["loan-schedules", loanId],
    queryFn: async () => {
      if (!loanId) return [];
      const { data, error } = await supabase
        .from("loan_repayment_schedule")
        .select("id,loan_id,sequence,due_period_end,scheduled_amount,status")
        .eq("loan_id", loanId)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ScheduleRow[];
    },
    enabled: !!loanId,
  });

  const loanLabel = useMemo(() => {
    const m = new Map<string, { label: string; employee_id: string }>();
    for (const l of loans) {
      const label = `${l.loan_number ?? `Loan ${l.id.slice(0, 8)}`} · principal ${l.principal_amount} · outstanding ${l.outstanding_balance ?? "—"}`;
      m.set(l.id, { label, employee_id: l.employee_id });
    }
    return m;
  }, [loans]);

  // Source-filtered view feeds both KPIs and the tab buckets so filters apply consistently.
  const filtered = useMemo(
    () => overrides.filter((o) => sourceFilter === "__all__" || o.source === sourceFilter),
    [overrides, sourceFilter],
  );

  const buckets = useMemo(() => {
    return {
      pending: filtered.filter((o) => o.status === "pending"),
      approved: filtered.filter((o) => o.status === "approved"),
      history: filtered.filter((o) =>
        ["rejected", "cancelled", "expired", "consumed"].includes(o.status),
      ),
    };
  }, [filtered]);

  // KPIs — operator-facing "insight at a glance" strip.
  const kpis = useMemo(() => {
    const deferred = filtered
      .filter((o) => o.status === "approved")
      .reduce((sum, o) => sum + (scheduleById.get(o.schedule_id)?.scheduled_amount ?? 0), 0);
    const payrollIds = new Set(filtered.filter((o) => o.status === "approved" || o.status === "pending").map((o) => o.payroll_run_id));
    const loanIds = new Set(filtered.filter((o) => o.status === "approved" || o.status === "pending").map((o) => o.loan_id));
    return {
      pending: filtered.filter((o) => o.status === "pending").length,
      approvedUnconsumed: filtered.filter((o) => o.status === "approved").length,
      payrollsAffected: payrollIds.size,
      loansAffected: loanIds.size,
      deferredPrincipal: deferred,
    };
  }, [filtered, scheduleById]);

  async function submit() {
    if (!runId || runId === "__all__" || !loanId || !scheduleId || !reason.trim()) return;
    const empId = loanLabel.get(loanId)?.employee_id;
    if (!empId) return;
    await createOverride.mutateAsync({
      payroll_run_id: runId,
      loan_id: loanId,
      schedule_id: scheduleId,
      employee_id: empId,
      reason: reason.trim(),
      reason_category: reasonCategory,
      evidence_url: evidenceUrl.trim() || undefined,
    });
    setOpen(false);
    setLoanId(""); setScheduleId(""); setReason(""); setEvidenceUrl("");
  }

  function renderTable(rows: typeof overrides, kind: "pending" | "approved" | "history") {
    if (rows.length === 0) {
      return <p className="text-sm text-muted-foreground py-4">Nothing here.</p>;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Loan / Employee</TableHead>
            <TableHead>Installment</TableHead>
            <TableHead>Strategy</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Maker</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((o) => {
            const loan = loanById.get(o.loan_id);
            const sched = scheduleById.get(o.schedule_id);
            const lt = loan?.loan_type_id ? loanTypeById.get(loan.loan_type_id) : undefined;
            return (
            <TableRow key={o.id}>
              <TableCell>
                <Badge variant={STATUS_VARIANT[o.status]}>{o.status}</Badge>
                {o.source !== "user" && (
                  <Badge variant="outline" className="ml-1 text-[10px]">{o.source}</Badge>
                )}
                <div className="mt-1">
                  <Link
                    to={`/hr/payroll/runs/${o.payroll_run_id}`}
                    className="text-[10px] underline text-muted-foreground inline-flex items-center gap-0.5"
                  >
                    run <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                </div>
              </TableCell>
              <TableCell className="text-xs">
                <Link
                  to={`/hr/employees/${o.employee_id}/loans/${o.loan_id}`}
                  className="underline text-primary inline-flex items-center gap-0.5"
                >
                  {loan?.loan_number ?? o.loan_id.slice(0, 8)}
                  <ExternalLink className="h-2.5 w-2.5" />
                </Link>
                <div className="text-[10px] text-muted-foreground font-mono">emp {o.employee_id.slice(0, 8)}</div>
              </TableCell>
              <TableCell className="text-xs">
                {sched ? (
                  <>
                    <div>#{sched.sequence} · {sched.scheduled_amount}</div>
                    <div className="text-[10px] text-muted-foreground">{sched.due_period_end} · {sched.status}</div>
                  </>
                ) : (
                  <span className="font-mono">{o.schedule_id.slice(0, 8)}</span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {lt ? (
                  <Link
                    to={`/hr/payroll/loan-types/${lt.id}`}
                    className="underline inline-flex items-center gap-0.5"
                  >
                    {lt.schedule_adjustment_on_skip ?? "push_end"}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="max-w-xs">
                <div className="text-sm">{o.reason}</div>
                {o.reason_category && (
                  <div className="text-[10px] text-muted-foreground">{o.reason_category}</div>
                )}
                {o.evidence_url && (
                  <a href={o.evidence_url} target="_blank" rel="noreferrer" className="text-[10px] underline text-primary">
                    evidence
                  </a>
                )}
                {o.rejection_reason && (
                  <div className="text-[10px] text-destructive">Rejected: {o.rejection_reason}</div>
                )}
                {o.status === "consumed" && o.consumed_at && (
                  <div className="text-[10px] text-muted-foreground">consumed {new Date(o.consumed_at).toLocaleDateString()}</div>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">{o.created_by?.slice(0, 8) ?? "—"}</TableCell>
              <TableCell className="text-xs">{new Date(o.created_at).toLocaleString()}</TableCell>
              <TableCell className="text-right space-x-1">
                {kind === "pending" && (
                  <>
                    <Button size="sm" variant="default"
                      onClick={() => approveOverride.mutate(o.id)}>
                      <Check className="h-3.5 w-3.5 mr-1" /> Approve
                    </Button>
                    <Button size="sm" variant="outline"
                      onClick={() => {
                        const r = prompt("Rejection reason?");
                        if (r) rejectOverride.mutate({ id: o.id, reason: r });
                      }}>
                      <X className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => { if (confirm("Remove this pending override?")) deleteOverride.mutate(o.id); }}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </>
                )}
                {kind === "approved" && (
                  <Button size="sm" variant="outline"
                    onClick={() => {
                      const r = prompt("Cancellation reason?");
                      if (r) cancelOverride.mutate({ id: o.id, reason: r });
                    }}>
                    <ShieldAlert className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                )}
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Ban className="h-5 w-5" /> Loan Repayment Skip Overrides</CardTitle>
          <CardDescription>
            Maker-checker exception log. Approved overrides are honoured by compute-payroll;
            schedules are adjusted automatically per the loan type's skip policy. Approvers
            cannot self-approve their own submissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiTile icon={<Clock className="h-4 w-4" />} label="Pending approvals" value={kpis.pending} />
            <KpiTile icon={<CheckCircle2 className="h-4 w-4" />} label="Approved · not yet consumed" value={kpis.approvedUnconsumed} />
            <KpiTile icon={<Layers className="h-4 w-4" />} label="Payroll runs affected" value={kpis.payrollsAffected} />
            <KpiTile icon={<Users className="h-4 w-4" />} label="Loans affected" value={kpis.loansAffected} />
            <KpiTile icon={<DollarSign className="h-4 w-4" />} label="Deferred principal (approved)" value={kpis.deferredPrincipal.toFixed(2)} />
          </div>

          <div className="flex gap-3 items-end">
            <div className="flex-1 max-w-sm">
              <Label>Payroll run</Label>
              <Select value={runId} onValueChange={setRunId}>
                <SelectTrigger><SelectValue placeholder="All runs" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All open runs</SelectItem>
                  {runs.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.payroll_number ?? r.id.slice(0, 8)} · {r.pay_period_start} → {r.pay_period_end} ({r.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-40">
              <Label>Source</Label>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All sources</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="hr_event">HR event</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => setOpen(true)} disabled={!runId || runId === "__all__"}>
              <Plus className="h-4 w-4 mr-1" /> New Override
            </Button>
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList>
                <TabsTrigger value="pending">Pending ({buckets.pending.length})</TabsTrigger>
                <TabsTrigger value="approved">Approved ({buckets.approved.length})</TabsTrigger>
                <TabsTrigger value="history">History ({buckets.history.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="pending">{renderTable(buckets.pending, "pending")}</TabsContent>
              <TabsContent value="approved">{renderTable(buckets.approved, "approved")}</TabsContent>
              <TabsContent value="history">{renderTable(buckets.history, "history")}</TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        title="Submit Loan Skip Override"
        description="Submission requires a separate approver. Approved overrides are honoured by compute-payroll and will automatically adjust the loan amortisation per the loan type's policy."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}
              disabled={!loanId || !scheduleId || !reason.trim()}>
              Submit for approval
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Loan & installment" subtitle="Pick the active loan and the specific scheduled installment to skip.">
          <WorkflowField label="Loan" required>
            <Select value={loanId} onValueChange={(v) => { setLoanId(v); setScheduleId(""); }}>
              <SelectTrigger><SelectValue placeholder="Select active loan" /></SelectTrigger>
              <SelectContent>
                {loans.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{loanLabel.get(l.id)?.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Installment to skip" required>
            <Select value={scheduleId} onValueChange={setScheduleId} disabled={!loanId}>
              <SelectTrigger><SelectValue placeholder="Select installment" /></SelectTrigger>
              <SelectContent>
                {schedules.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    #{s.sequence} · {s.due_period_end} · {s.scheduled_amount} · {s.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Justification" subtitle="Category, narrative, and optional evidence. Visible to approvers and internal audit.">
          <WorkflowField label="Category" required>
            <Select value={reasonCategory} onValueChange={setReasonCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASON_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Reason" required>
            <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Employee on unpaid leave for the period; deferral approved by manager." />
          </WorkflowField>
          <WorkflowField label="Evidence URL (optional)">
            <Input value={evidenceUrl} onChange={(e) => setEvidenceUrl(e.target.value)}
              placeholder="https://…" />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </div>
  );
}
