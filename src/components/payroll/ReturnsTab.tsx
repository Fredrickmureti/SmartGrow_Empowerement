import { normalizeError } from "@/services/resilience";
/**
 * Returns Tab — surface for `payroll_return_runs` (Stage R7 UI).
 *
 * Pure UI over `useStatutoryReturns`. Country-agnostic: every column,
 * authority, due date, and rule filter is read from
 * `localization_pack_return_templates.body`. New countries enter via a
 * pack INSERT only — no code changes here.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Download, FileText, AlertTriangle, CheckCircle2, GitBranch, History } from "lucide-react";
import { ReturnRunHistoryDrawer } from "./ReturnRunHistoryDrawer";
import { WorkflowSheet, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useReturnTemplates,
  useReturnRuns,
  useGenerateStatutoryReturn,
  useRecordReturnAcknowledgement,
  useHasInstalledLocalizationPack,
  usePayrollRunsInPeriod,
  useReturnEligibility,
  downloadReturnArtifact,
  type ReturnRun,
} from "@/hooks/payroll/useStatutoryReturns";

const STATUS_BADGE: Record<ReturnRun["status"], string> = {
  draft:                   "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  generated:               "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  pending_approval:        "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  submitted_awaiting_ack:  "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  acknowledged:            "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  rejected:                "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  filed:                   "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  superseded:              "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

function periodWindow(period: "monthly" | "quarterly" | "annual", year: number, idx: number) {
  // idx: 1..12 (monthly), 1..4 (quarterly), 1 (annual)
  if (period === "monthly") {
    const m = idx; // 1..12
    const start = new Date(Date.UTC(year, m - 1, 1));
    const end = new Date(Date.UTC(year, m, 0));
    return { start, end };
  }
  if (period === "quarterly") {
    const startMonth = (idx - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1));
    const end = new Date(Date.UTC(year, startMonth + 3, 0));
    return { start, end };
  }
  return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 11, 31)) };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function ReturnsTab() {
  const { toast } = useToast();
  const { can } = usePermissions();
  const canWrite = can("managePayroll") || can("manageRemittances");
  const [ackRun, setAckRun] = useState<ReturnRun | null>(null);
  const [historyRun, setHistoryRun] = useState<ReturnRun | null>(null);
  const recordAck = useRecordReturnAcknowledgement();

  const { data: templates = [], isLoading: loadingTpl } = useReturnTemplates();
  const { data: hasInstalledPack = false } = useHasInstalledLocalizationPack();
  const [templateCode, setTemplateCode] = useState<string>("");
  const activeTpl = useMemo(
    () => templates.find((t) => t.code === templateCode) ?? templates[0],
    [templates, templateCode],
  );

  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const periodOptions = useMemo(() => {
    if (!activeTpl) return [] as Array<{ idx: number; label: string }>;
    if (activeTpl.period === "monthly") {
      return Array.from({ length: 12 }, (_, i) => ({
        idx: i + 1,
        label: format(new Date(Date.UTC(year, i, 1)), "MMM yyyy"),
      }));
    }
    if (activeTpl.period === "quarterly") {
      return Array.from({ length: 4 }, (_, i) => ({ idx: i + 1, label: `Q${i + 1} ${year}` }));
    }
    return [{ idx: 1, label: `FY ${year}` }];
  }, [activeTpl, year]);
  const [periodIdx, setPeriodIdx] = useState<number>(1);

  const { data: runs = [], isLoading: loadingRuns } = useReturnRuns({
    templateCode: activeTpl?.code,
    year,
  });

  const generate = useGenerateStatutoryReturn();

  // Guard: don't offer Generate for a period with zero payroll_runs — the
  // edge function has nothing to aggregate and would 500 late.
  const { start: periodStartD, end: periodEndD } = activeTpl
    ? periodWindow(activeTpl.period, year, periodIdx)
    : { start: null as Date | null, end: null as Date | null };
  const periodStartStr = periodStartD ? ymd(periodStartD) : undefined;
  const periodEndStr = periodEndD ? ymd(periodEndD) : undefined;
  const { data: runsInPeriodCount, isLoading: loadingRunsInPeriod } = usePayrollRunsInPeriod({
    periodStart: periodStartStr,
    periodEnd: periodEndStr,
  });
  const hasPayrollRuns = (runsInPeriodCount ?? 0) > 0;

  const { data: eligibility, isLoading: loadingEligibility } = useReturnEligibility({
    template: activeTpl,
    periodStart: periodStartStr,
    periodEnd: periodEndStr,
  });
  const accrualPayslipReadiness = !!eligibility?.required_statuses.includes("approved");

  const onGenerate = async () => {
    if (!activeTpl) return;
    const { start, end } = periodWindow(activeTpl.period, year, periodIdx);
    const periodStart = ymd(start);
    const periodEnd = ymd(end);
    const existingActive = runs.find(
      (r) =>
        r.period_start === periodStart &&
        r.period_end === periodEnd &&
        (r.status === "generated" || r.status === "filed"),
    );
    const regenerate = !!existingActive;
    if (regenerate) {
      const ok = window.confirm(
        `An active ${activeTpl.code} run already exists for this period. Regenerate? The existing run will be marked superseded.`,
      );
      if (!ok) return;
    }
    try {
      const res: any = await generate.mutateAsync({
        template_code: activeTpl.code,
        period_start: periodStart,
        period_end: periodEnd,
        regenerate,
      });
      const diff = res?.run?.payload?.reconciliation?.diff;
      toast({
        title: regenerate ? "Return regenerated" : "Return generated",
        description:
          typeof diff === "number" && Math.abs(diff) > 0.01
            ? `Reconciliation variance: ${diff.toFixed(2)} — review payroll liabilities.`
            : "Reconciles with payroll liabilities.",
      });
    } catch (err: any) {
      const normalized = normalizeError(err);
      toast({
        title: normalized.title,
        description: `${normalized.message} ${normalized.action}`,
        variant: "destructive",
      });
    }
  };

  if (loadingTpl) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-2">
          <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="font-medium">No return templates available</p>
          <p className="text-sm text-muted-foreground">
            {hasInstalledPack
              ? "A localization pack is installed for this business, but it publishes no statutory return templates. Contact the pack publisher or check the publisher portal."
              : "Install a localization pack for this business to enable statutory returns. Templates are pack-driven and country-agnostic — they appear here as soon as the pack is installed, no payroll run required."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const yearOptions = Array.from({ length: 6 }, (_, i) => currentYear - i);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate statutory return</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Template</label>
              <Select value={activeTpl?.code} onValueChange={setTemplateCode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.code} value={t.code}>
                      {t.display_name} {t.authority_name ? `· ${t.authority_name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Year</label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Period</label>
              <Select value={String(periodIdx)} onValueChange={(v) => setPeriodIdx(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {periodOptions.map((p) => (
                    <SelectItem key={p.idx} value={String(p.idx)}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              {canWrite ? (
                <Button
                  onClick={onGenerate}
                  disabled={
                    generate.isPending ||
                    !activeTpl ||
                    loadingRunsInPeriod ||
                    loadingEligibility ||
                    !hasPayrollRuns ||
                    (eligibility && !eligibility.ready)
                  }
                  className="w-full"
                >
                  {generate.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Generate
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Read-only access. Ask an admin for payroll write permission to generate returns.</p>
              )}
            </div>
          </div>
          {activeTpl && !loadingRunsInPeriod && !hasPayrollRuns && canWrite && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              No payroll runs exist for the selected period. Run payroll first — there's nothing to aggregate.
            </p>
          )}
          {activeTpl && hasPayrollRuns && eligibility && !eligibility.ready && canWrite && (
            <div className="text-xs mt-3 rounded-md border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-950/30 p-3 space-y-1">
              <div className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                {eligibility.blocking_reason === "no_approved_run"
                  ? "Awaiting payroll approval"
                  : "Awaiting payslip readiness"}
              </div>
              {eligibility.blocking_reason === "no_approved_run" ? (
                <p className="text-muted-foreground">
                  No approved payroll run intersects this period. Approve the run in Payroll → Control Center, then return here — payment and GL posting are not required first.
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    This template files from payslips in status{" "}
                    <span className="font-mono">
                      {eligibility.required_statuses.length
                        ? eligibility.required_statuses.join(" | ")
                        : "any"}
                    </span>
                    . None of the {eligibility.total_payslips_count} payslip
                    {eligibility.total_payslips_count === 1 ? "" : "s"} on the approved run
                    {eligibility.approved_runs_count === 1 ? "" : "s"} match.
                  </p>
                  {Object.keys(eligibility.status_breakdown).length > 0 && (
                    <p className="text-muted-foreground">
                      Current breakdown:{" "}
                      {Object.entries(eligibility.status_breakdown)
                        .map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`)
                        .join(", ")}
                      .
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    {accrualPayslipReadiness
                      ? "The payroll run is approved, but the template is not seeing an approval-final payslip status. Finalize payroll approval; employee payment is not required to generate statutory return documents."
                      : "This template is still configured to exclude approved payslips. Update the localization return template so statutory documents file from approved payroll results; payment belongs to remittance settlement."}
                  </p>
                </>
              )}
            </div>
          )}
          {activeTpl && hasPayrollRuns && eligibility?.ready && canWrite && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-3 flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Ready — {eligibility.eligible_payslips_count} eligible payslip
              {eligibility.eligible_payslips_count === 1 ? "" : "s"} across{" "}
              {eligibility.approved_runs_count} approved run
              {eligibility.approved_runs_count === 1 ? "" : "s"}.
            </p>
          )}
          {activeTpl?.description && (
            <p className="text-xs text-muted-foreground mt-3">{activeTpl.description}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generated runs ({year})</CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {loadingRuns ? (
            <div className="p-6"><Skeleton className="h-32 w-full" /></div>
          ) : runs.length === 0 ? (
            <p className="text-muted-foreground text-center py-8 px-4">
              No return runs yet for this template and year.
            </p>
          ) : (
            <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Serial</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Generated</TableHead>
                    <TableHead className="text-right">Reconciliation</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => {
                    const diff = r.payload?.reconciliation?.diff;
                    const reconOk = typeof diff === "number" && Math.abs(diff) < 0.01;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">
                          {format(new Date(r.period_start), "MMM d")} – {format(new Date(r.period_end), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.serial_number}</TableCell>
                        <TableCell>
                          <Badge className={STATUS_BADGE[r.status]} variant="secondary">{r.status}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(r.generated_at), "MMM d, yyyy HH:mm")}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {typeof diff === "number" ? (
                            <span className={reconOk ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
                              {reconOk ? "Balanced" : `Δ ${diff.toFixed(2)}`}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm" variant="outline"
                              disabled={!r.csv_path}
                              onClick={async () => {
                                if (!r.csv_path) return;
                                try {
                                  await downloadReturnArtifact(r.csv_path);
                                } catch (err: any) {
                                  toast({
                                    title: "CSV download failed",
                                    description: normalizeError(err).message,
                                    variant: "destructive",
                                  });
                                }
                              }}
                            >
                              <Download className="h-3.5 w-3.5 mr-1" /> CSV
                            </Button>
                            <Button
                              size="sm" variant="outline"
                              disabled={!r.pdf_path}
                              onClick={async () => {
                                if (!r.pdf_path) return;
                                try {
                                  await downloadReturnArtifact(r.pdf_path);
                                } catch (err: any) {
                                  toast({
                                    title: "PDF download failed",
                                    description: normalizeError(err).message,
                                    variant: "destructive",
                                  });
                                }
                              }}
                            >
                              <FileText className="h-3.5 w-3.5 mr-1" /> PDF
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => setHistoryRun(r)}
                              title="Show amendment chain and transition timeline"
                            >
                              <History className="h-3.5 w-3.5 mr-1" /> History
                            </Button>
                            {canWrite && (r.status === "generated" || r.status === "submitted_awaiting_ack" || r.status === "rejected") && (
                              <Button
                                size="sm" variant="outline"
                                onClick={() => setAckRun(r)}
                                title="Record the authority's acknowledgement or rejection"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Record ack
                              </Button>
                            )}
                            {canWrite && (r.status === "acknowledged" || r.status === "filed") && (
                              <Button
                                size="sm" variant="outline"
                                onClick={async () => {
                                  const ok = window.confirm(
                                    `Amend ${r.serial_number}? A new run will be generated, this one will be superseded, and the chain will be preserved.`,
                                  );
                                  if (!ok) return;
                                  try {
                                    await generate.mutateAsync({
                                      template_code: r.template_code,
                                      period_start: r.period_start,
                                      period_end: r.period_end,
                                      regenerate: true,
                                    });
                                    toast({ title: "Amendment generated", description: `Previous run marked superseded.` });
                                  } catch (err: any) {
                                    toast({ title: "Amendment failed", description: normalizeError(err).message, variant: "destructive" });
                                  }
                                }}
                                title="Generate an amendment; supersedes this run"
                              >
                                <GitBranch className="h-3.5 w-3.5 mr-1" /> Amend
                              </Button>
                            )}
                          </div>

                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AcknowledgementDialog
        run={ackRun}
        onClose={() => setAckRun(null)}
        isPending={recordAck.isPending}
        onSubmit={async (payload) => {
          if (!ackRun) return;
          try {
            await recordAck.mutateAsync({
              run_id: ackRun.id,
              organization_id: ackRun.organization_id,
              business_id: ackRun.business_id,
              ...payload,
            });
            toast({ title: "Acknowledgement recorded", description: `Status set to ${payload.outcome}` });
            setAckRun(null);
          } catch (e: any) {
            toast({ title: "Failed to record acknowledgement", description: e?.message ?? String(e), variant: "destructive" });
          }
        }}
      />
      <ReturnRunHistoryDrawer run={historyRun} onClose={() => setHistoryRun(null)} />
    </div>
  );
}

interface AckPayload {
  outcome: "submitted_awaiting_ack" | "acknowledged" | "rejected" | "filed";
  filed_reference?: string | null;
  acknowledged_at?: string | null;
  ack: { receipt_number?: string; receipt_date?: string; authority_status?: string; notes?: string };
}

// Mirrors payroll_return_assert_transition() server-side state machine.
const ALLOWED_NEXT: Record<string, AckPayload["outcome"][]> = {
  draft: [],
  generated: ["submitted_awaiting_ack", "filed"],
  pending_approval: ["submitted_awaiting_ack", "filed"],
  submitted_awaiting_ack: ["acknowledged", "rejected", "filed"],
  acknowledged: ["filed"],
  rejected: ["submitted_awaiting_ack"],
  filed: [],
};

const OUTCOME_LABEL: Record<AckPayload["outcome"], string> = {
  submitted_awaiting_ack: "Submitted — awaiting acknowledgement",
  acknowledged: "Acknowledged by authority",
  filed: "Filed (acknowledged + on record)",
  rejected: "Rejected by authority",
};

function AcknowledgementDialog({
  run, onClose, onSubmit, isPending,
}: {
  run: ReturnRun | null;
  onClose: () => void;
  onSubmit: (payload: AckPayload) => Promise<void>;
  isPending: boolean;
}) {
  const allowed = run ? (ALLOWED_NEXT[run.status] ?? []) : [];
  const [outcome, setOutcome] = useState<AckPayload["outcome"]>(allowed[0] ?? "submitted_awaiting_ack");
  const [receiptNumber, setReceiptNumber] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [authorityStatus, setAuthorityStatus] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (run && !allowed.includes(outcome)) {
      setOutcome(allowed[0] ?? "submitted_awaiting_ack");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status]);

  if (!run) return null;
  const submit = () =>
    onSubmit({
      outcome,
      filed_reference: receiptNumber || null,
      acknowledged_at: receiptDate ? new Date(receiptDate).toISOString() : null,
      ack: {
        receipt_number: receiptNumber || undefined,
        receipt_date: receiptDate || undefined,
        authority_status: authorityStatus || undefined,
        notes: notes || undefined,
      },
    });

  const noneAllowed = allowed.length === 0;

  return (
    <WorkflowSheet
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Record authority acknowledgement"
      description={
        noneAllowed
          ? `This return is in terminal status "${run.status}" and cannot be transitioned further.`
          : `Current status: ${run.status}. Only transitions valid from this state are shown — e.g. an authority acknowledgement can only be recorded after the return has been submitted.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={submit} disabled={isPending || noneAllowed}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Record
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Outcome">
        <WorkflowField label="Outcome" required>
          <Select value={outcome} onValueChange={(v) => setOutcome(v as AckPayload["outcome"])} disabled={noneAllowed}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {allowed.map((o) => (
                <SelectItem key={o} value={o}>{OUTCOME_LABEL[o]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WorkflowField>
      </WorkflowSheetSection>


      <WorkflowSheetSection number={2} title="Receipt">
        <WorkflowField label="Authority receipt / reference number">
          <Input value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} placeholder="e.g. KRA-PAYE-2025-08-72415" />
        </WorkflowField>
        <div className="grid grid-cols-2 gap-3">
          <WorkflowField label="Receipt date">
            <Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
          </WorkflowField>
          <WorkflowField label="Authority status code">
            <Input value={authorityStatus} onChange={(e) => setAuthorityStatus(e.target.value)} placeholder="e.g. ACCEPTED" />
          </WorkflowField>
        </div>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={3} title="Audit notes">
        <WorkflowField label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any extra context for audit." rows={4} />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

export default ReturnsTab;