import { normalizeError } from "@/services/resilience";
import { useDrillDownAnchor } from "@/hooks/payroll/useDrillDownAnchor";
/**
 * Payroll workspace section pages.
 *
 * Stage 3 + completion: real Readiness (joins employee_contracts),
 * real Work Entries list, configuration hub linked only to live routes,
 * Payslip Detail with header + PDF download + salary redaction support.
 */
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { useEmployeePayrollReadiness } from "@/hooks/payroll/useEmployeePayrollReadiness";
import {
  usePayrollWorkEntries,
  usePayrollRunIssues,
  usePayslipLines,
  usePayrollPaymentBatches,
  useAllPayslips,
} from "@/hooks/payroll/usePayrollWorkspaceData";
import { usePayroll } from "@/hooks/usePayroll";
import { usePayrollPayments } from "@/hooks/payroll/usePayrollPayments";
import { CreatePaymentBatchDialog } from "@/components/payroll/CreatePaymentBatchDialog";
import { PayrollPaymentBatchItemsDialog } from "@/components/payroll/PayrollPaymentBatchItemsDialog";
import { PayslipLineExplainer } from "@/components/payroll/PayslipLineExplainer";
import { PayslipHeader } from "@/components/payroll/PayslipHeader";
import { usePayslipHeader as useSharedPayslipHeader } from "@/lib/payroll/payslipHeader";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { useState, useMemo, useEffect } from "react";
import { Download, AlertTriangle, Mail, FileDown } from "lucide-react";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { toast } from "sonner";
import {
  exportBatchToBankFile,
  listBankExportTemplates,
  type BankExportTemplate,
} from "@/lib/payroll/bankDisbursementExport";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function PageHeader({ title, hint, eyebrow }: { title: string; hint: string; eyebrow?: string }) {
  return (
    <div className="mb-4">
      {eyebrow && (
        <span className="inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-primary/10 text-primary mb-1">
          {eyebrow}
        </span>
      )}
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Currency cell that hides the amount when the user lacks viewSalaryDetails. */
function MoneyCell({ amount, canSee }: { amount: number | null | undefined; canSee: boolean }) {
  const { formatCurrency } = useCurrency();
  if (!canSee) {
    return <Badge variant="secondary" className="font-normal">Hidden</Badge>;
  }
  return <>{formatCurrency(amount ?? 0)}</>;
}

// ─── Readiness ──────────────────────────────────────────────────────────
import { usePayrollReadiness, type PayrollReadinessBlocker } from "@/hooks/payroll/usePayrollReadiness";
import { usePayrollPeriodEmployees } from "@/hooks/payroll/useEmployeePayrollReadiness";
import { usePayrollPeriods } from "@/hooks/usePayrollPeriods";
import { RefreshCw, CheckCircle2, ArrowRight, Loader2, PlayCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { downloadPayslipPdf } from "@/services/payroll/payslipDocuments";


type PopulationMode = "in_period" | "active" | "selected";

function BlockerRow({ b, employeeId }: { b: PayrollReadinessBlocker; employeeId?: string | null }) {
  const link = b.remediation_link
    ? (employeeId
        ? b.remediation_link.replace(":employee_id", employeeId).replace("{employee_id}", employeeId)
        : b.remediation_link)
    : null;
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <div className="font-medium flex items-center gap-2">
          {b.rule_name}
          <Badge
            variant={b.severity === "block" ? "destructive" : "secondary"}
            className={b.severity === "block" ? "text-[10px]" : "text-[10px] bg-amber-100 text-amber-900"}
          >
            {b.severity === "block" ? "Blocks payroll" : "Warning"}
          </Badge>
          {b.scope && b.scope !== "org" && (
            <Badge variant="outline" className="text-[10px] capitalize">{b.scope}</Badge>
          )}
        </div>
        <div className="text-muted-foreground">{b.reason}</div>
        {b.subject_label && (
          <div className="text-xs text-muted-foreground mt-0.5">Subject: {b.subject_label}</div>
        )}
        {b.missing_fields && b.missing_fields.length > 0 && (
          <div className="text-xs text-muted-foreground mt-0.5">Missing: {b.missing_fields.join(", ")}</div>
        )}
      </div>
      {/* deep-link remediation buttons rendered below */}
      {link && !link.includes(":employee_id") && (
        <Button size="sm" variant="outline" asChild>
          <Link to={link}>
            {b.remediation_label || "Fix"} <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
    </div>
  );
}

/**
 * OrgBusinessReadinessPanel — renders the engine's org-scope AND business-scope
 * blockers in one card. Replaces the legacy org-only panel so the badge can
 * never disagree with the body of the page below it.
 */
function OrgBusinessReadinessPanel({
  orgBlockers,
  businessBlockers,
  isLoading,
  hasEvaluation,
  evaluate,
}: {
  orgBlockers: PayrollReadinessBlocker[];
  businessBlockers: PayrollReadinessBlocker[];
  isLoading: boolean;
  hasEvaluation: boolean;
  evaluate: ReturnType<typeof usePayrollReadiness>["evaluate"];
}) {
  const blockCount =
    orgBlockers.filter((b) => b.severity === "block").length +
    businessBlockers.filter((b) => b.severity === "block").length;
  const warnCount =
    orgBlockers.filter((b) => b.severity === "warn").length +
    businessBlockers.filter((b) => b.severity === "warn").length;
  const ready = hasEvaluation && blockCount === 0;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            {ready ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
            Organization &amp; business readiness
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {hasEvaluation
              ? `${warnCount} warnings · ${blockCount} blocking`
              : "Not evaluated yet."}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => evaluate.mutate()} disabled={evaluate.isPending || isLoading}>
          {evaluate.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
          {hasEvaluation ? "Re-evaluate" : "Evaluate now"}
        </Button>
      </CardHeader>
      {hasEvaluation && (orgBlockers.length > 0 || businessBlockers.length > 0) && (
        <CardContent className="space-y-2 pt-0">
          {orgBlockers.map((b, idx) => (
            <BlockerRow key={`org-${b.rule_code}-${idx}`} b={{ ...b, scope: "org" }} />
          ))}
          {businessBlockers.map((b, idx) => (
            <BlockerRow key={`biz-${b.rule_code}-${idx}`} b={{ ...b, scope: "business" }} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function ReadinessStatusBadge({ status, severity }: { status: string; severity: string }) {
  if (status === "pass") return <Badge variant="outline" className="text-emerald-700 border-emerald-300">OK</Badge>;
  if (status === "na")   return <Badge variant="secondary">N/A</Badge>;
  if (status === "fail" && severity === "block") return <Badge variant="destructive">Blocked</Badge>;
  if (status === "fail") return <Badge variant="secondary" className="bg-amber-100 text-amber-900">Warning</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function KpiTile({ label, value, tone }: { label: string; value: number; tone: "ready" | "warn" | "block" | "na" }) {
  const cls =
    tone === "ready" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : tone === "warn" ? "text-amber-900 bg-amber-50 border-amber-200"
    : tone === "block" ? "text-red-700 bg-red-50 border-red-200"
    : "text-muted-foreground bg-muted/40 border-border";
  return (
    <div className={`rounded-md border px-3 py-2 ${cls}`}>
      <div className="text-2xl font-semibold leading-tight">{value}</div>
      <div className="text-[11px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

export function PayrollReadiness() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { periods, isLoading: periodsLoading } = usePayrollPeriods();

  // Default to the next non-closed period covering or following today;
  // fall back to the most recent period if none are open.
  const defaultPeriodId = useMemo(() => {
    if (!periods.length) return null;
    const today = format(new Date(), "yyyy-MM-dd");
    const open = periods.filter((p) => p.status !== "closed");
    const covering = open.find((p) => p.start_date <= today && p.end_date >= today);
    if (covering) return covering.id;
    const upcoming = open
      .filter((p) => p.end_date >= today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
    if (upcoming) return upcoming.id;
    return periods[0]?.id ?? null;
  }, [periods]);

  const urlPeriodId = searchParams.get("period_id");
  const urlPeriodStart = searchParams.get("period_start");
  const urlPeriodEnd = searchParams.get("period_end");
  const urlPopulation = (searchParams.get("population") as PopulationMode | null) ?? "in_period";

  const [periodId, setPeriodId] = useState<string | null>(urlPeriodId);
  const [population, setPopulation] = useState<PopulationMode>(urlPopulation);
  const [mode, setMode] = useState<"by_employee" | "by_rule">("by_employee");
  const [selectedEmp, setSelectedEmp] = useState<string | null>(null);

  // Resolve current period bounds (URL wins if explicit, otherwise picker).
  const pickedPeriod = useMemo(
    () => periods.find((p) => p.id === periodId) ?? null,
    [periods, periodId],
  );
  const periodStart = pickedPeriod?.start_date ?? urlPeriodStart ?? null;
  const periodEnd = pickedPeriod?.end_date ?? urlPeriodEnd ?? null;

  // Initialize picker from URL or default once periods load.
  useEffect(() => {
    if (periodId || periodsLoading || !defaultPeriodId) return;
    setPeriodId(defaultPeriodId);
  }, [periodId, periodsLoading, defaultPeriodId]);

  // Population scoping → employee id list passed to the engine.
  const periodEmployees = usePayrollPeriodEmployees({
    periodStart,
    periodEnd,
    enabled: !!periodStart && !!periodEnd,
  });
  const inPeriodIds = useMemo(
    () => (periodEmployees.data ?? []).map((e) => e.employee_id),
    [periodEmployees.data],
  );

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const effectiveIds: string[] | null = useMemo(() => {
    if (population === "in_period") return inPeriodIds.length ? inPeriodIds : null;
    if (population === "selected") return selectedIds;
    return null; // "active" → engine default
  }, [population, inPeriodIds, selectedIds]);

  const matrix = useEmployeePayrollReadiness({
    periodStart,
    periodEnd,
    employeeIds: effectiveIds,
  });
  const summary = usePayrollReadiness({
    periodStart,
    periodEnd,
    employeeIds: effectiveIds,
  });

  // Sync controls into the URL so deep links survive refresh.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (periodId) next.set("period_id", periodId); else next.delete("period_id");
    if (periodStart) next.set("period_start", periodStart); else next.delete("period_start");
    if (periodEnd) next.set("period_end", periodEnd); else next.delete("period_end");
    next.set("population", population);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, periodStart, periodEnd, population]);

  const rules = matrix.data?.rules ?? [];
  const employees = matrix.data?.employees ?? [];
  const focused = selectedEmp ? employees.find((e) => e.employee_id === selectedEmp) ?? null : null;

  // Header KPIs: employees ready / warned / blocked / na, plus org+business blockers.
  const kpis = useMemo(() => {
    let ready = 0, warned = 0, blocked = 0, naOnly = 0;
    for (const e of employees) {
      if (e.blockers_count > 0) blocked++;
      else if (e.warnings_count > 0) warned++;
      else if (e.pass_count === 0 && e.na_count > 0) naOnly++;
      else ready++;
    }
    const orgBlock = (summary.orgBlockers ?? []).filter((b) => b.severity === "block").length;
    const bizBlock = (summary.businessBlockers ?? []).filter((b) => b.severity === "block").length;
    return { ready, warned, blocked, naOnly, orgBlock, bizBlock };
  }, [employees, summary.orgBlockers, summary.businessBlockers]);

  const masterReady = summary.isReady && kpis.blocked === 0;

  const ruleAgg = useMemo(() => {
    return rules.map((r) => {
      let blocked = 0, warned = 0, na = 0, passed = 0;
      for (const e of employees) {
        const s = e.rule_status[r.code];
        if (s === "fail") {
          if (r.severity === "block") blocked++; else warned++;
        } else if (s === "na") na++;
        else if (s === "pass") passed++;
      }
      return { rule: r, blocked, warned, na, passed };
    });
  }, [rules, employees]);

  const readyEmployeeIds = useMemo(
    () => employees.filter((e) => e.is_ready).map((e) => e.employee_id),
    [employees],
  );

  const handleCreateRun = () => {
    const params = new URLSearchParams();
    params.set("action", "create");
    if (periodStart) params.set("period_start", periodStart);
    if (periodEnd) params.set("period_end", periodEnd);
    if (periodId) params.set("period_id", periodId);
    if (readyEmployeeIds.length) params.set("employee_ids", readyEmployeeIds.join(","));
    navigate(`/hr/payroll/runs?${params.toString()}`);
  };

  const canCreateRun =
    masterReady === true ||
    (kpis.orgBlock === 0 && kpis.bizBlock === 0 && readyEmployeeIds.length > 0);

  const isLoading = matrix.isLoading || summary.isLoading || periodsLoading;

  return (
    <div>
      <PageHeader
        title="Payroll Readiness"
        hint="Pre-run gate for the selected period. Resolves org, business and per-employee blockers from the canonical engine."
      />

      {/* Toolbar */}
      <Card className="mb-4">
        <CardContent className="p-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Period</div>
              <Select
                value={periodId ?? ""}
                onValueChange={(v) => { setPeriodId(v); setSelectedEmp(null); }}
                disabled={periodsLoading || periods.length === 0}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder={periods.length ? "Select a period" : "No periods generated yet"} />
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {format(new Date(p.start_date), "MMM d")}–{format(new Date(p.end_date), "MMM d, yyyy")}
                      {p.status === "closed" ? " (closed)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Population</div>
              <Select value={population} onValueChange={(v) => { setPopulation(v as PopulationMode); setSelectedEmp(null); }}>
                <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_period">In period ({inPeriodIds.length})</SelectItem>
                  <SelectItem value="active">Active today</SelectItem>
                  <SelectItem value="selected" disabled={inPeriodIds.length === 0}>Selected ({selectedIds.length})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">View</div>
              <Select value={mode} onValueChange={(v) => setMode(v as "by_employee" | "by_rule")}>
                <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="by_employee">By employee</SelectItem>
                  <SelectItem value="by_rule">By rule</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <Badge
              variant={masterReady ? "outline" : "destructive"}
              className={masterReady ? "border-emerald-300 text-emerald-700" : ""}
            >
              {masterReady ? "Ready to run" : `${kpis.blocked + kpis.orgBlock + kpis.bizBlock} blockers`}
            </Badge>
            <Button
              size="sm"
              onClick={handleCreateRun}
              disabled={!canCreateRun}
              title={canCreateRun ? `Create run with ${readyEmployeeIds.length} ready employees` : "Resolve blockers first"}
            >
              <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
              Create run with ready employees
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <KpiTile label="Ready" value={kpis.ready} tone="ready" />
        <KpiTile label="Warnings" value={kpis.warned} tone="warn" />
        <KpiTile label="Blocked" value={kpis.blocked} tone="block" />
        <KpiTile label="N/A only" value={kpis.naOnly} tone="na" />
      </div>

      <OrgBusinessReadinessPanel
        orgBlockers={summary.orgBlockers ?? []}
        businessBlockers={summary.businessBlockers ?? []}
        isLoading={summary.isLoading}
        hasEvaluation={summary.hasEvaluation}
        evaluate={summary.evaluate}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Employees</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {employees.length} in scope · {kpis.ready} ready · {kpis.warned} warnings · {kpis.blocked} blocked · {kpis.naOnly} N/A
            </p>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? <p className="p-4 text-sm">Loading…</p> : mode === "by_employee" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {population === "selected" && (
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={inPeriodIds.length > 0 && selectedIds.length === inPeriodIds.length}
                        onChange={(e) => setSelectedIds(e.target.checked ? inPeriodIds : [])}
                      />
                    </TableHead>
                  )}
                  <TableHead>Employee</TableHead>
                  <TableHead>Emp #</TableHead>
                  {rules.map((r) => (
                    <TableHead key={r.code} title={r.description ?? r.name}>{r.name}</TableHead>
                  ))}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map((r) => (
                  <TableRow
                    key={r.employee_id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelectedEmp(r.employee_id)}
                  >
                    {population === "selected" && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(r.employee_id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked
                                ? Array.from(new Set([...prev, r.employee_id]))
                                : prev.filter((id) => id !== r.employee_id),
                            )
                          }
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{r.first_name} {r.last_name}</TableCell>
                    <TableCell>{r.employee_number || "—"}</TableCell>
                    {rules.map((rule) => (
                      <TableCell key={rule.code}>
                        <ReadinessStatusBadge status={r.rule_status[rule.code] ?? "na"} severity={rule.severity as string} />
                      </TableCell>
                    ))}
                    <TableCell>
                      {r.is_ready
                        ? <Badge variant="outline" className="border-emerald-300 text-emerald-700">Ready</Badge>
                        : r.blockers_count > 0
                          ? <Badge variant="destructive">{r.blockers_count} blocking</Badge>
                          : r.warnings_count > 0
                            ? <Badge variant="secondary" className="bg-amber-100 text-amber-900">{r.warnings_count} warning</Badge>
                            : <Badge variant="secondary">N/A</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
                {employees.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={rules.length + (population === "selected" ? 4 : 3)} className="text-center text-sm text-muted-foreground py-6">
                      No employees in scope for this period.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead className="text-right">Passing</TableHead>
                  <TableHead className="text-right">Blocking</TableHead>
                  <TableHead className="text-right">Warnings</TableHead>
                  <TableHead className="text-right">N/A</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ruleAgg.map(({ rule, blocked, warned, na, passed }) => {
                  const link = rule.remediation_link && !rule.remediation_link.includes(":employee_id")
                    ? (() => {
                        const u = new URL(rule.remediation_link!, "http://x");
                        if (periodStart) u.searchParams.set("period_start", periodStart);
                        if (periodEnd) u.searchParams.set("period_end", periodEnd);
                        return u.pathname + (u.search ? u.search : "");
                      })()
                    : null;
                  return (
                    <TableRow key={rule.code}>
                      <TableCell>
                        <div className="font-medium">{rule.name}</div>
                        <div className="text-xs text-muted-foreground">{rule.description}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={rule.severity === "block" ? "destructive" : "secondary"}>{rule.severity}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{passed}</TableCell>
                      <TableCell className="text-right">{blocked}</TableCell>
                      <TableCell className="text-right">{warned}</TableCell>
                      <TableCell className="text-right">{na}</TableCell>
                      <TableCell>
                        {link && (
                          <Button size="sm" variant="outline" asChild>
                            <Link to={link}>
                              {rule.remediation_label || "Configure"} <ArrowRight className="ml-1 h-3.5 w-3.5" />
                            </Link>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {focused && (
        <Card className="mt-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">{focused.first_name} {focused.last_name} — readiness detail</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {focused.pass_count} passing · {focused.warnings_count} warnings · {focused.blockers_count} blocking · {focused.na_count} N/A
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelectedEmp(null)}>Close</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {focused.findings.map((f) => {
              const link = f.remediation_link?.replace(":employee_id", focused.employee_id).replace("{employee_id}", focused.employee_id) ?? null;
              return (
                <div key={f.rule_code} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <div className="font-medium flex items-center gap-2">
                      <ReadinessStatusBadge status={f.status} severity={f.severity as string} />
                      {f.rule_name}
                    </div>
                    <div className="text-muted-foreground">{f.reason}</div>
                    {f.missing_fields && f.missing_fields.length > 0 && (
                      <div className="text-xs text-muted-foreground mt-0.5">Missing: {f.missing_fields.join(", ")}</div>
                    )}
                  </div>
                  {link && f.status !== "pass" && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to={link}>
                        {f.remediation_label || "Fix"} <ArrowRight className="ml-1 h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Work Entries ───────────────────────────────────────────────────────
export function PayrollWorkEntriesPage() {
  const { payrollRuns } = usePayroll();
  const openRuns = useMemo(
    () => payrollRuns.filter((r: any) => r.status === "draft" || r.status === "processed" || r.status === "approved"),
    [payrollRuns],
  );
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const effectiveRunId = runId ?? openRuns[0]?.id;
  const entries = usePayrollWorkEntries(effectiveRunId);
  const issues = usePayrollRunIssues(effectiveRunId);
  const conflictEmpIds = useMemo(
    () => new Set((issues.data ?? []).filter((i) => i.severity !== "info").map((i) => i.employee_id).filter(Boolean) as string[]),
    [issues.data],
  );
  // Phase 4 P4 — drill-down landing: `?entry={work_entry_id}` highlights
  // the matching row; `?input={payslip_input_id}` is accepted for symmetry
  // even though work_entries don't carry input ids today (the column will
  // hydrate when variable inputs land in the work-entry materialiser).
  const entryAnchor = useDrillDownAnchor("entry", {
    ready: !entries.isLoading,
    rowIdPrefix: "work-entry-",
  });

  return (
    <div>
      <PageHeader title="Work Entries" hint="Hours rolled up per payroll run from attendance, leave, and timesheets." />
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Run:</span>
            <Select value={effectiveRunId} onValueChange={setRunId}>
              <SelectTrigger className="w-[280px]"><SelectValue placeholder="Pick a payroll run" /></SelectTrigger>
              <SelectContent>
                {openRuns.map((r: any) => (
                  <SelectItem key={r.id} value={r.id}>{r.payroll_number} · {r.status}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto"><Button asChild size="sm" variant="outline"><Link to="/hr/payroll/runs">All runs</Link></Button></div>
          </div>
          {!effectiveRunId ? (
            <p className="text-sm text-muted-foreground">No open payroll runs. Create one from the Runs page.</p>
          ) : entries.isLoading ? <p className="text-sm">Loading…</p> : (entries.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No work entries synced yet for this run.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead><TableHead>Period</TableHead>
                  <TableHead className="text-right">Hours</TableHead><TableHead className="text-right">OT</TableHead>
                  <TableHead>Source</TableHead><TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.data!.map((w) => {
                  const conflict = conflictEmpIds.has(w.employee_id);
                  const anchor = entryAnchor.getAnchorProps(w.id);
                  return (
                    <TableRow
                      key={w.id}
                      id={anchor.id}
                      data-anchor={anchor["data-anchor"]}
                      className={[conflict ? "bg-destructive/5" : "", anchor.className].filter(Boolean).join(" ") || undefined}
                    >
                      <TableCell className="font-mono text-xs">{w.employee_id.slice(0, 8)}</TableCell>
                      <TableCell>{w.work_date_start} → {w.work_date_end}</TableCell>
                      <TableCell className="text-right">{w.hours.toFixed(2)}</TableCell>
                      <TableCell className="text-right">{w.overtime_hours.toFixed(2)}</TableCell>
                      <TableCell><Badge variant="outline">{w.source}</Badge></TableCell>
                      <TableCell>{conflict && <span title="Has open issue"><AlertTriangle className="h-4 w-4 text-amber-500" /></span>}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Run Detail (header + totals + payslips + issues + work entries + GL link) ──
function useRunSummary(runId?: string) {
  return useQuery({
    queryKey: ["payroll-run-summary", runId],
    enabled: !!runId,
    queryFn: async () => {
      const [run, je, payslips] = await Promise.all([
        supabase.from("payroll_runs").select("*").eq("id", runId!).maybeSingle(),
        supabase
          .from("journal_entries")
          .select("id, entry_number, status")
          .eq("source_type", "payroll")
          .eq("source_id", runId!)
          .maybeSingle(),
        supabase
          .from("payslips")
          .select("id, payslip_number, gross_pay, net_pay, status, employee:employees(first_name, last_name, employee_number)")
          .eq("payroll_run_id", runId!),
      ]);
      return {
        run: (run as any).data,
        je: (je as any).data,
        payslips: ((payslips as any).data ?? []) as any[],
      };
    },
  });
}

export function PayrollRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { formatCurrency } = useCurrency();
  const { can } = usePermissions();
  const canSee = can("viewSalaryDetails");
  const summary = useRunSummary(runId);
  const issues = usePayrollRunIssues(runId);
  const entries = usePayrollWorkEntries(runId);
  const run = summary.data?.run;
  const je = summary.data?.je;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={run ? `Payroll ${run.payroll_number}` : "Payroll Run"}
          hint={run ? `${run.pay_period_start} → ${run.pay_period_end}` : `Run ${runId}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          {run?.status && <Badge variant="outline">{run.status}</Badge>}
          {je?.id && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/finance/journal-entries?selected=${je.id}`}>JE {je.entry_number || ""}</Link>
            </Button>
          )}
          <Button asChild size="sm" variant="ghost"><Link to="/hr/payroll/runs">All runs</Link></Button>
        </div>
      </div>

      {run && (
        <Card>
          <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><div className="text-muted-foreground">Employees</div><div className="font-medium">{run.employee_count ?? 0}</div></div>
            <div><div className="text-muted-foreground">Gross</div><div className="font-medium"><MoneyCell amount={run.total_gross} canSee={canSee} /></div></div>
            <div><div className="text-muted-foreground">Net</div><div className="font-medium"><MoneyCell amount={run.total_net} canSee={canSee} /></div></div>
            <div><div className="text-muted-foreground">Payment Date</div><div className="font-medium">{run.payment_date || "—"}</div></div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Payslips</CardTitle></CardHeader>
        <CardContent className="p-0">
          {summary.isLoading ? <p className="p-4 text-sm">Loading…</p> : (summary.data?.payslips ?? []).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No payslips.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Net</TableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {summary.data!.payslips.map((ps) => (
                  <TableRow key={ps.id}>
                    <TableCell>{ps.employee ? `${ps.employee.first_name} ${ps.employee.last_name}` : ps.id.slice(0,8)}</TableCell>
                    <TableCell><Badge variant="outline">{ps.status}</Badge></TableCell>
                    <TableCell className="text-right"><MoneyCell amount={ps.gross_pay} canSee={canSee} /></TableCell>
                    <TableCell className="text-right"><MoneyCell amount={ps.net_pay} canSee={canSee} /></TableCell>
                    <TableCell className="text-right"><Button asChild size="sm" variant="ghost"><Link to={`/hr/payroll/payslips/${ps.id}`}>Open</Link></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Issues</CardTitle></CardHeader>
        <CardContent>
          {issues.isLoading ? "Loading…" : (issues.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No issues.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {issues.data!.map((i) => (
                <li key={i.id} className="flex gap-2">
                  <Badge variant={i.severity === "blocker" ? "destructive" : "outline"}>{i.severity}</Badge>
                  <span>{i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Work Entries</CardTitle></CardHeader>
        <CardContent>
          {entries.isLoading ? "Loading…" : (entries.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No work entries synced yet.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Hours</TableHead><TableHead className="text-right">OT</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
              <TableBody>
                {entries.data!.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-mono text-xs">{w.employee_id.slice(0, 8)}</TableCell>
                    <TableCell>{w.work_date_start} → {w.work_date_end}</TableCell>
                    <TableCell className="text-right">{w.hours.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{w.overtime_hours.toFixed(2)}</TableCell>
                    <TableCell><Badge variant="outline">{w.source}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Payslips list ──────────────────────────────────────────────────────
export function PayslipsListPage() {
  const { data, isLoading } = useAllPayslips();
  const { can } = usePermissions();
  const canSee = can("viewSalaryDetails");
  // Bulk emailing payslips discloses net pay — gate on view-salary AND any payroll operator role.
  const canEmail = can("viewPayroll") && canSee && (can("runPayroll") || can("approvePayroll") || can("postPayrollGL") || can("payPayroll") || can("managePayroll"));
  const [emailTarget, setEmailTarget] = useState<{ id: string; name?: string; number?: string } | null>(null);
  return (
    <div>
      <PageHeader title="Payslips" hint="Searchable list of payslips across all runs for this business." />
      <Card>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm">Loading…</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Net</TableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {(data ?? []).map((ps: any) => {
                  const empName = `${ps.employee?.first_name ?? ""} ${ps.employee?.last_name ?? ""}`.trim();
                  return (
                    <TableRow key={ps.id}>
                      <TableCell>{empName}</TableCell>
                      <TableCell><Badge variant="outline">{ps.status}</Badge></TableCell>
                      <TableCell className="text-right"><MoneyCell amount={ps.gross_pay} canSee={canSee} /></TableCell>
                      <TableCell className="text-right"><MoneyCell amount={ps.net_pay} canSee={canSee} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {canEmail && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEmailTarget({ id: ps.id, name: empName, number: ps.payslip_number })}
                              aria-label="Email payslip"
                            >
                              <Mail className="h-4 w-4" />
                            </Button>
                          )}
                          <Button asChild size="sm" variant="ghost"><Link to={`/hr/payroll/payslips/${ps.id}`}>Open</Link></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {emailTarget && (
        <SendDocumentDialog
          open={!!emailTarget}
          onOpenChange={(o) => { if (!o) setEmailTarget(null); }}
          document={{
            documentType: "payslip",
            documentId: emailTarget.id,
            documentNumber: emailTarget.number || emailTarget.id,
            recipientName: emailTarget.name,
          }}
        />
      )}
    </div>
  );
}

// ─── Payslip detail (header + lines + PDF download) ─────────────────────
//
// IMPORTANT: this page renders the country-agnostic shared
// <PayslipHeader/> backed by the `payslip_header` RPC. It must NOT
// build its own header from `employees`/`payslips` — that path drops
// statutory identifiers (Tax PIN / NSSF / SHIF / RSSB / etc) and
// causes drift between the admin page, the in-app dialog, the
// /me/payslips portal view, and the PDF. See
// `src/test/architecture/payslip-header-surface-contract.test.ts`.
function usePayslipSummary(payslipId?: string) {
  return useQuery({
    queryKey: ["payslip-summary", payslipId],
    enabled: !!payslipId,
    queryFn: async () => {
      // v_payslips_redacted enforces salary privacy at column level via RLS.
      // Only the numeric summary is read here; identity/employer/employee
      // statutory blocks come from the shared header model below.
      const { data, error } = await supabase
        .from("v_payslips_redacted" as any)
        .select("id, status, gross_pay, net_pay, payroll_run_id")
        .eq("id", payslipId!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });
}

export function PayslipDetailPage() {
  const { payslipId } = useParams<{ payslipId: string }>();
  const lines = usePayslipLines(payslipId);
  const summary = usePayslipSummary(payslipId);
  const headerQuery = useSharedPayslipHeader(payslipId);
  const { can } = usePermissions();
  const canSee = can("viewSalaryDetails");
  const canEmail = can("viewPayroll") && canSee && (can("runPayroll") || can("approvePayroll") || can("postPayrollGL") || can("payPayroll") || can("managePayroll"));
  const [downloading, setDownloading] = useState(false);
  const [showEmail, setShowEmail] = useState(false);

  const handleDownload = async () => {
    if (!payslipId) return;
    setDownloading(true);
    try {
      await downloadPayslipPdf(payslipId, { filename: `payslip-${payslipId}` });
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to download payslip");
    } finally {
      setDownloading(false);
    }
  };


  const header = headerQuery.data;
  const s: any = summary.data;
  const period = header?.period;
  const hint = period?.payroll_number
    ? `${period.payroll_number} · ${period.pay_period_start ?? ""} → ${period.pay_period_end ?? ""}`
    : `Line-by-line breakdown · ${payslipId}`;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title="Payslip" hint={hint} />
        <div className="flex gap-2">
          {canEmail && payslipId && (
            <Button onClick={() => setShowEmail(true)} size="sm" variant="outline">
              <Mail className="h-4 w-4 mr-1.5" /> Email
            </Button>
          )}
          <Button onClick={handleDownload} disabled={downloading || !payslipId} size="sm" variant="outline">
            <Download className="h-4 w-4 mr-1.5" /> {downloading ? "Generating…" : "Download PDF"}
          </Button>
        </div>
      </div>

      {showEmail && payslipId && (
        <SendDocumentDialog
          open={showEmail}
          onOpenChange={setShowEmail}
          document={{
            documentType: "payslip",
            documentId: payslipId,
            documentNumber: period?.payroll_number || payslipId,
            recipientName: header?.employee?.name,
          }}
        />
      )}

      {header && <PayslipHeader header={header} />}

      {s && (
        <Card>
          <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><div className="text-xs text-muted-foreground">Status</div><Badge variant="outline" className="capitalize">{s.status}</Badge></div>
            <div><div className="text-xs text-muted-foreground">Gross</div><div className="font-medium"><MoneyCell amount={s.gross_pay} canSee={canSee} /></div></div>
            <div><div className="text-xs text-muted-foreground">Net</div><div className="font-medium"><MoneyCell amount={s.net_pay} canSee={canSee} /></div></div>
          </CardContent>
        </Card>
      )}


      <Card>
        <CardHeader><CardTitle className="text-base">Lines</CardTitle></CardHeader>
        <CardContent className="p-0">
          {lines.isLoading ? <p className="p-4 text-sm">Loading…</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Label</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Employee</TableHead><TableHead className="text-right">Employer</TableHead></TableRow></TableHeader>
              <TableBody>
                {(lines.data ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs">{l.rule_code}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        {l.label}
                        <PayslipLineExplainer line={l} hideAmounts={!canSee} employeeId={header?.employee?.id} />
                      </span>
                    </TableCell>
                    <TableCell><Badge variant="outline">{l.category}</Badge></TableCell>
                    <TableCell className="text-right"><MoneyCell amount={l.employee_amount} canSee={canSee} /></TableCell>
                    <TableCell className="text-right"><MoneyCell amount={l.employer_amount} canSee={canSee} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Payments ───────────────────────────────────────────────────────────
const reconStateLabel: Record<string, string> = {
  unposted: "Unposted",
  posted_unmatched: "Posted · unmatched",
  matched_unconfirmed: "Matched · pending",
  confirmed: "Reconciled",
  reversed: "Reversed",
  cancelled: "Cancelled",
};
const reconStateVariant: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  unposted: "secondary",
  posted_unmatched: "outline",
  matched_unconfirmed: "outline",
  confirmed: "default",
  reversed: "destructive",
  cancelled: "secondary",
};

export function PayrollPaymentsPage() {
  const { data, isLoading } = usePayrollPaymentBatches();
  const { payrollRuns } = usePayroll();
  const {
    markBatchPaid, approveBatch, lockBatch, markBatchTransmitted,
    cancelBatch, reverseBatch,
  } = usePayrollPayments();
  const { can } = usePermissions();
  const canSee = can("viewSalaryDetails");
  const canManage = can("payPayroll");

  // Phase D — reconciliation surface
  const { data: recon } = useQuery({
    queryKey: ["payroll-payment-reconciliation"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_payroll_payment_reconciliation" as any)
        .select("batch_id, batch_status, reconciliation_state, items_total, items_paid, items_failed, items_pending, items_held, amount_paid, amount_failed, amount_pending, bank_export_status, bank_export_format, total_amount")
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });
  const reconByBatch = useMemo(() => {
    const m: Record<string, any> = {};
    for (const r of recon ?? []) m[r.batch_id] = r;
    return m;
  }, [recon]);

  // KPIs
  const kpis = useMemo(() => {
    const list = recon ?? [];
    const sum = (k: string) => list.reduce((s, r) => s + Number(r[k] || 0), 0);
    return {
      batchCount: list.length,
      paidAmount: sum("amount_paid"),
      failedAmount: sum("amount_failed"),
      pendingAmount: sum("amount_pending"),
      awaitingRecon: list.filter((r) => r.reconciliation_state === "posted_unmatched" || r.reconciliation_state === "matched_unconfirmed").length,
      failedItems: list.reduce((s, r) => s + Number(r.items_failed || 0), 0),
    };
  }, [recon]);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reconFilter, setReconFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    return (data ?? []).filter((b: any) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      const r = reconByBatch[b.id];
      if (reconFilter !== "all" && r?.reconciliation_state !== reconFilter) return false;
      return true;
    });
  }, [data, statusFilter, reconFilter, reconByBatch]);

  const [bankTemplates, setBankTemplates] = useState<BankExportTemplate[]>([]);
  useEffect(() => { listBankExportTemplates().then(setBankTemplates).catch(() => setBankTemplates([])); }, []);

  const runsWithoutBatch = useMemo(() => {
    const haveBatch = new Set((data ?? []).filter((b: any) => b.status !== "cancelled").map((b: any) => b.payroll_run_id));
    return (payrollRuns ?? []).filter((r: any) => (r.status === "posted" || r.status === "paid") && !haveBatch.has(r.id));
  }, [payrollRuns, data]);

  const [refByBatch, setRefByBatch] = useState<Record<string, string>>({});
  const [createFor, setCreateFor] = useState<{ id: string; number: string } | null>(null);
  const [drillBatch, setDrillBatch] = useState<{ id: string; number: string } | null>(null);

  const fmtMoney = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <PageHeader title="Payments" hint="Payroll payment batches grouped by run." />
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" asChild><Link to="/hr/payroll/payments/register">Register</Link></Button>
          <Button variant="outline" size="sm" asChild><Link to="/hr/payroll/payments/files">Bank files</Link></Button>
          <Button variant="outline" size="sm" asChild><Link to="/hr/payroll/payments/failed">Failed</Link></Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Batches</div><div className="text-2xl font-semibold tabular-nums">{kpis.batchCount}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Paid</div><div className="text-2xl font-semibold tabular-nums">{canSee ? fmtMoney(kpis.paidAmount) : "•••"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Pending</div><div className="text-2xl font-semibold tabular-nums">{canSee ? fmtMoney(kpis.pendingAmount) : "•••"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Failed items</div><div className="text-2xl font-semibold tabular-nums text-destructive">{kpis.failedItems}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Awaiting recon</div><div className="text-2xl font-semibold tabular-nums">{kpis.awaitingRecon}</div></CardContent></Card>
      </div>

      {canManage && runsWithoutBatch.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Posted runs without a payment batch</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {runsWithoutBatch.map((r: any) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="font-mono">{r.payroll_number}</span>
                <Button size="sm" variant="outline" onClick={() => setCreateFor({ id: r.id, number: r.payroll_number })}>
                  Create payment batch
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {createFor && (
        <CreatePaymentBatchDialog
          open={!!createFor}
          onOpenChange={(o) => !o && setCreateFor(null)}
          payrollRunId={createFor.id}
          payrollNumber={createFor.number}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Batch status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft","pending","approved","locked","exported","transmitted","partially_paid","paid","failed","cancelled","reversed"].map(s => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={reconFilter} onValueChange={setReconFilter}>
          <SelectTrigger className="h-8 w-52 text-xs"><SelectValue placeholder="Reconciliation" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All reconciliation</SelectItem>
            {Object.keys(reconStateLabel).map(s => (
              <SelectItem key={s} value={s}>{reconStateLabel[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm">Loading…</p> : filtered.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No payment batches match.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Batch #</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reconciliation</TableHead>
                <TableHead>Bank file</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Payment Date</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {filtered.map((b) => {
                  const r = reconByBatch[b.id];
                  const recState = r?.reconciliation_state ?? "unposted";
                  return (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">
                      <button className="hover:underline" onClick={() => setDrillBatch({ id: b.id, number: b.batch_number })}>
                        {b.batch_number}
                      </button>
                    </TableCell>
                    <TableCell><Badge variant="outline">{b.status}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={reconStateVariant[recState] ?? "outline"}>{reconStateLabel[recState] ?? recState}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r?.bank_export_status ? (
                        <span>{r.bank_export_format} · <Badge variant="outline">{r.bank_export_status}</Badge></span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {r ? (
                        <span>
                          <span className="text-foreground">{r.items_paid}</span>
                          <span className="text-muted-foreground">/{r.items_total}</span>
                          {r.items_failed > 0 && <span className="ml-1 text-destructive">·{r.items_failed} failed</span>}
                          {r.items_held > 0 && <span className="ml-1 text-muted-foreground">·{r.items_held} held</span>}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell>{b.payment_date ? format(new Date(b.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell className="text-right"><MoneyCell amount={b.total_amount} canSee={canSee} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDrillBatch({ id: b.id, number: b.batch_number })}>
                          Items
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" title="Download bank disbursement file">
                              <FileDown className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {bankTemplates.length === 0 && (<DropdownMenuItem disabled>No bank formats installed</DropdownMenuItem>)}
                            {bankTemplates.map((tpl) => (
                              <DropdownMenuItem
                                key={tpl.id}
                                onClick={async () => {
                                  try {
                                    const res = await exportBatchToBankFile(b.id, tpl.format_code);
                                    toast.success(`Exported ${res.rowCount} row(s)` + (res.missingBankCount ? ` · ${res.missingBankCount} missing bank account` : ""));
                                  } catch (e: any) { toast.error(normalizeError(e).message || "Export failed"); }
                                }}
                              >{tpl.display_name}</DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {canManage && b.status !== "paid" && b.status !== "cancelled" && b.status !== "reversed" && (
                          <>
                            <input
                              placeholder="Ref / reason"
                              className="h-8 w-32 rounded border px-2 text-xs"
                              value={refByBatch[b.id] || ""}
                              onChange={(e) => setRefByBatch((m) => ({ ...m, [b.id]: e.target.value }))}
                            />
                            {/* Lifecycle action bar — drives the server state machine.
                                Buttons gate on current status so users only ever see
                                legal transitions. SoD trigger blocks self-approval. */}
                            {(b.status === "draft" || b.status === "pending") && (
                              <Button size="sm" variant="outline" disabled={approveBatch.isPending}
                                onClick={() => approveBatch.mutate({ batch_id: b.id, note: refByBatch[b.id] })}
                              >Approve</Button>
                            )}
                            {b.status === "approved" && (
                              <Button size="sm" variant="outline" disabled={lockBatch.isPending}
                                onClick={() => lockBatch.mutate({ batch_id: b.id })}
                              >Lock</Button>
                            )}
                            {b.status === "exported" && (
                              <Button size="sm" variant="outline" disabled={markBatchTransmitted.isPending}
                                onClick={() => markBatchTransmitted.mutate({ batch_id: b.id, reference: refByBatch[b.id] })}
                              >Transmit</Button>
                            )}
                            {(b.status === "transmitted" || b.status === "partially_paid" || b.status === "exported" || b.status === "locked") && (
                              <Button size="sm" variant="outline" disabled={markBatchPaid.isPending}
                                onClick={() => markBatchPaid.mutate({ batch_id: b.id, payment_reference: refByBatch[b.id] })}
                              >Mark paid</Button>
                            )}
                            {b.status !== "paid" && (
                              <Button size="sm" variant="ghost" disabled={cancelBatch.isPending}
                                onClick={() => cancelBatch.mutate({ batch_id: b.id, reason: refByBatch[b.id] || "" })}
                              >Cancel</Button>
                            )}
                            {b.status === "paid" && (
                              <Button size="sm" variant="ghost" className="text-destructive" disabled={reverseBatch.isPending}
                                onClick={() => reverseBatch.mutate({ batch_id: b.id, reason: refByBatch[b.id] || "" })}
                              >Reverse</Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PayrollPaymentBatchItemsDialog
        open={!!drillBatch}
        onOpenChange={(o) => !o && setDrillBatch(null)}
        batchId={drillBatch?.id ?? null}
        batchNumber={drillBatch?.number}
      />
    </div>
  );
}


// ─── Configuration hub ──────────────────────────────────────────────────
export function PayrollConfigurationPage() {
  const groups: Array<{
    label: string;
    hint: string;
    links: Array<{ to: string; label: string; hint: string }>;
  }> = [
    {
      label: "Pay cycle",
      hint: "How and when payroll is calculated.",
      links: [
        { to: "/hr/payroll/configuration/schedules",  label: "Pay Schedules",     hint: "Pay periods, frequencies & cut-offs" },
        { to: "/hr/payroll/configuration/structures", label: "Salary Structures", hint: "Earnings & deduction rule sets" },
        { to: "/hr/payroll/configuration/work-entry-types", label: "Work Entry Types", hint: "Overtime, leave, holiday, unpaid…" },
        { to: "/hr/payroll/configuration/input-types",     label: "Variable Input Types", hint: "Overtime, bonus, commission columns on each run" },
      ],
    },
    {
      label: "Statutory & compliance",
      hint: "Localized tax, social, and court-ordered obligations.",
      links: [
        { to: "/hr/payroll/statutory-rules",            label: "Statutory Rules",   hint: "Tax, pension & social contributions" },
        { to: "/hr/payroll/legal-orders",               label: "Legal Orders",      hint: "Court orders, aggregate caps & take-home floor" },
        { to: "/hr/payroll/configuration/localization", label: "Localization Pack", hint: "Country-specific payroll rules" },
      ],
    },
    {
      label: "Accounting & documents",
      hint: "How payroll posts to the ledger and what employees receive.",
      links: [
        { to: "/hr/payroll/configuration/accounts",  label: "GL Account Mapping", hint: "Map rules & statutory items to ledger accounts" },
        { to: "/hr/payroll/configuration/templates", label: "Payslip Templates",  hint: "Payslip layout & display preferences" },
      ],
    },
    {
      label: "Lending",
      hint: "Employee loans and advance policy.",
      links: [
        { to: "/hr/payroll/configuration/loan-types", label: "Loan Types",         hint: "Loan products, interest & repayment policy" },
        { to: "/hr/payroll/loan-skip-overrides",      label: "Loan Skip Overrides", hint: "Per-run repayment exemptions" },
      ],
    },
    {
      label: "Get started",
      hint: "First-run readiness check.",
      links: [
        { to: "/hr/payroll/setup", label: "Setup Wizard", hint: "Guided checklist to activate payroll" },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll Settings"
        hint="Everything that drives the payroll engine — pay cycle, statutory, accounting, lending."
        eyebrow="Payroll"
      />
      {groups.map((group) => (
        <section key={group.label} className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h2>
            <p className="text-xs text-muted-foreground">{group.hint}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {group.links.map((l) => (
              <Link key={l.to} to={l.to}>
                <Card className="hover:bg-muted/50 transition h-full">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{l.label}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{l.hint}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ─── Schedules (delegates to existing PayrollPeriodsAdmin) ──────────────
export { PayrollPeriodsAdmin as PayrollSchedulesPage } from "@/components/payroll/PayrollPeriodsAdmin";

// Reports page lives in its own file (Stage 4)
export { PayrollReportsPage } from "@/pages/hr/payroll/Reports";

// New Stage 3 config sub-pages live in their own files for lazy-loading.
export { PayrollSalaryStructuresPage } from "@/pages/hr/payroll/SalaryStructures";
export { PayrollAccountMappingPage } from "@/pages/hr/payroll/AccountMapping";
