import { PayrollRun, Payslip } from "@/hooks/usePayroll";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePayrollGL } from "@/hooks/usePayrollGL";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, Loader2, FileText, ChevronDown, BookOpen, Mail, CheckCircle, DollarSign, Banknote, FileDown, AlertTriangle, Trash2, RotateCcw } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "react-router-dom";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig, ExportColumn } from "@/services/reports/ReportExportService";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { PayrollAuditTrail } from "@/components/payroll/PayrollAuditTrail";
import { canReverseRun, getLineageBadge } from "@/lib/payroll/runLifecycle";
import { PayrollRuleSetPanel } from "@/components/payroll/PayrollRuleSetPanel";
import { normalizeError } from "@/services/resilience";
import { PayrollMappingFindingsPanel } from "@/components/payroll/PayrollMappingFindingsPanel";
import { usePayrollMappingFindings } from "@/hooks/payroll/usePayrollMappingFindings";
import { useReturnTemplates } from "@/hooks/payroll/useStatutoryReturns";
import { PayrollPostingPreviewDialog } from "@/components/payroll/PayrollPostingPreviewDialog";

/** Build an ExportConfig for the Payroll Register (gross-to-net per employee) */
function getPayrollRegisterExportConfig(
  run: PayrollRun,
  payslips: Payslip[],
  formatCurrency: (v: number) => string,
  organizationId?: string,
): ExportConfig {
  const periodLabel = `${format(new Date(run.pay_period_start), "MMM d")} – ${format(new Date(run.pay_period_end), "MMM d, yyyy")}`;

  // Collect all unique deduction keys across payslips
  const deductionKeys = new Set<string>();
  for (const ps of payslips) {
    if (ps.deductions_detail) Object.keys(ps.deductions_detail).forEach((k) => deductionKeys.add(k));
  }
  const sortedDeductionKeys = Array.from(deductionKeys).sort();

  const columns: ExportColumn[] = [
    { key: "employee", header: "Employee", width: 25 },
    { key: "employee_number", header: "Emp #", width: 12 },
    { key: "gross_pay", header: "Gross Pay", format: "currency", align: "right" },
    ...sortedDeductionKeys.map((k): ExportColumn => ({
      key: `ded_${k}`,
      header: k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      format: "currency",
      align: "right",
    })),
    { key: "total_deductions", header: "Total Deductions", format: "currency", align: "right" },
    { key: "net_pay", header: "Net Pay", format: "currency", align: "right" },
  ];

  const rows = payslips.map((ps) => {
    const row: Record<string, any> = {
      employee: ps.employee ? `${ps.employee.first_name} ${ps.employee.last_name}` : "Unknown",
      employee_number: ps.employee?.employee_number || "",
      gross_pay: ps.gross_pay,
      total_deductions: ps.total_deductions,
      net_pay: ps.net_pay,
    };
    for (const k of sortedDeductionKeys) {
      row[`ded_${k}`] = ps.deductions_detail?.[k] || 0;
    }
    return row;
  });

  // Grand total row
  const totals: Record<string, any> = {
    employee: "TOTAL",
    employee_number: "",
    gross_pay: payslips.reduce((s, p) => s + p.gross_pay, 0),
    total_deductions: payslips.reduce((s, p) => s + p.total_deductions, 0),
    net_pay: payslips.reduce((s, p) => s + p.net_pay, 0),
    _isGrandTotal: true,
  };
  for (const k of sortedDeductionKeys) {
    totals[`ded_${k}`] = payslips.reduce((s, p) => s + (p.deductions_detail?.[k] || 0), 0);
  }

  return {
    title: `Payroll Register — ${run.payroll_number}`,
    subtitle: periodLabel,
    dateRange: periodLabel,
    columns,
    rows: [...rows, totals],
    sheetName: "Payroll Register",
    currency: undefined, // Uses baseCurrency from ReportExportService automatically
    organizationId,
    reportType: "payroll_register",
  };
}

interface PayrollRunDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: PayrollRun | null;
  payslips: Payslip[];
  isLoadingPayslips: boolean;
  onApprove?: (run: PayrollRun) => void;
  onPostToGL?: (run: PayrollRun) => void;
  onMarkPaid?: (run: PayrollRun) => void;
  onDelete?: (run: PayrollRun) => Promise<void> | void;
  /** Run id currently being posted (driven by the parent so the spinner stays
   *  in sync regardless of which surface fired the post action). */
  postingRunId?: string | null;
  /** Reverse a posted/paid run (whole-run or per-employee correction). */
  onReverse?: (run: PayrollRun) => void;
}

/** Download a payroll document from the server-side Edge Function */
async function downloadPayrollDocument(
  payrollRunId: string,
  documentType: string,
  extras?: Record<string, string>
): Promise<void> {
  const { data, error } = await supabase.functions.invoke("generate-payroll-document", {
    body: { document_type: documentType, payroll_run_id: payrollRunId, ...extras },
  });

  if (error) throw error;

  const isPdf = documentType.includes("pdf") || documentType === "payslip";
  const mimeType = isPdf ? "application/pdf" : "text/csv";
  const ext = isPdf ? "pdf" : "csv";

  let blob: Blob;
  if (data instanceof Blob) {
    blob = data;
  } else if (data instanceof ArrayBuffer) {
    blob = new Blob([data], { type: mimeType });
  } else {
    blob = new Blob([typeof data === "string" ? data : JSON.stringify(data)], { type: mimeType });
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${documentType}_${payrollRunId.slice(0, 8)}.${ext}`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

/** Download an individual payslip PDF via the dedicated generate-payslip-pdf function */
async function downloadPayslipPdf(payrollRunId: string, payslipId: string, filename: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("generate-payslip-pdf", {
    body: { payslip_id: payslipId },
  });

  if (error) throw error;

  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

/** Generate and download a bank transfer schedule CSV from payslip data */
function downloadBankSchedule(payslips: Payslip[], payrollNumber: string): void {
  const headers = ["Employee Name", "Employee Number", "Bank Name", "Branch", "Account Number", "Net Pay", "Reference"];
  const csvRows = [headers.join(",")];

  for (const ps of payslips) {
    const emp = ps.employee;
    if (!emp) continue;
    const name = `"${emp.first_name} ${emp.last_name}"`;
    const empNum = emp.employee_number || "";
    const bankName = `"${(emp as any).bank_name || ""}"`;
    const branch = `"${(emp as any).bank_branch || ""}"`;
    const account = (emp as any).bank_account_number || "";
    const netPay = (ps.net_pay || 0).toFixed(2);
    const ref = `"SALARY-${payrollNumber}-${empNum}"`;
    csvRows.push([name, empNum, bankName, branch, account, netPay, ref].join(","));
  }

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Bank_Transfer_Schedule_${payrollNumber}.csv`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

// Statutory report routing is metadata-driven: the dialog reads installed
// `localization_pack_return_templates` for the org's active pack via
// `useReturnTemplates()` and forwards the user to the canonical Returns tab
// (`/hr/remittances`) where each template can be generated for a specific
// period with full reconciliation. The dialog itself never encodes country
// or report types — adding/removing a statutory return is a localization
// pack INSERT, not a code change here.

const getStatusBadge = (status: string) => {
  const styles: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    processing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    processed: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    approved: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
    cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };
  return <Badge className={styles[status] || ""}>{status}</Badge>;
};

export function PayrollRunDetailsDialog({
  open, onOpenChange, run, payslips, isLoadingPayslips, onApprove, onPostToGL, onMarkPaid, onDelete,
  postingRunId, onReverse,
}: PayrollRunDetailsDialogProps) {
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { postPayrollToGL } = usePayrollGL();
  const {
    can,
    canManagePayroll, // setup-only — retained for non-action surfaces (issue panel below)
    canRunPayroll,
    canApprovePayroll,
    canPostPayrollGL,
    canPayPayroll,
  } = usePermissions();
  const { toast } = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [localPosting, setLocalPosting] = useState(false);
  const isPostingGL = localPosting || (run?.id != null && postingRunId === run.id);
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");
  // Bulk emailing payslips reveals net pay → gate on view-salary AND a payroll
  // operator role (any granular payroll permission qualifies).
  const canEmailPayslips =
    can("viewPayroll") && can("viewSalaryDetails") &&
    (canRunPayroll || canApprovePayroll || canPostPayrollGL || canPayPayroll || canManagePayroll);

  // Pack-driven statutory returns (no country / report-type hardcoding).
  const { data: returnTemplatesData = [] } = useReturnTemplates();
  const returnTemplates = returnTemplatesData;

  // Surface compute-payroll skip-sink warnings (RULE_SKIPPED_UNKNOWN_METHOD, etc.)
  // NOTE: hooks MUST run on every render — do not early-return above this point
  // or React will crash with "Rendered more hooks than during the previous render".
  const queryClient = useQueryClient();
  const { data: runIssues = [] } = useQuery({
    queryKey: ["payroll-run-issues", run?.id],
    enabled: open && !!run?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_diagnostics" as any)
        .select("id, code, severity, message, details, created_at, resolved_at, dismissed_at, dismissed_by, dismissed_reason, employee_id, employee_first_name, employee_last_name, employee_number")
        .eq("payroll_run_id", run!.id)
        .is("resolved_at", null)
        .is("dismissed_at", null)
        .order("severity", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as Array<{
        id: string; code: string; severity: string; message: string; details: any;
        dismissed_at: string | null;
        employee_id: string | null; employee_first_name: string | null;
        employee_last_name: string | null; employee_number: string | null;
      }>;
    },
  });

  // Dismiss flow: only non-blocker severity, requires reason ≥10 chars
  const [dismissTarget, setDismissTarget] = useState<null | { id: string; code: string; message: string }>(null);
  const [dismissReason, setDismissReason] = useState("");

  const dismissMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes?.user?.id ?? null;
      const { error } = await supabase
        .from("payroll_run_issues" as any)
        .update({
          dismissed_at: new Date().toISOString(),
          dismissed_by: userId,
          dismissed_reason: reason.trim(),
        })
        .eq("id", id);
      if (error) throw error;
      // Best-effort audit log; ignore if table missing in some deployments.
      try {
        await supabase.from("payroll_audit_logs" as any).insert({
          payroll_run_id: run!.id,
          action: "diagnostic_dismissed",
          performed_by: userId,
          details: { issue_id: id, reason: reason.trim() },
        });
      } catch { /* swallow — audit best-effort */ }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payroll-run-issues", run?.id] });
      setDismissTarget(null);
      setDismissReason("");
      toast({ title: "Issue dismissed", description: "Recorded with reason in audit trail." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to dismiss", description: normalizeError(err).message ?? String(err), variant: "destructive" });
    },
  });

  // Must be called before any conditional early-return to preserve hook order.
  const { critical: criticalMappingFindings } = usePayrollMappingFindings();

  if (!run) return null;

  const periodLabel = `${format(new Date(run.pay_period_start), "MMM d")} - ${format(new Date(run.pay_period_end), "MMM d, yyyy")}`;
  // Statutory returns surface — pack-driven, no country branches.
  // Empty array ⇒ pack has no returns installed ⇒ hide the section entirely.

  const handleDownload = async (docType: string, label: string, extras?: Record<string, string>) => {
    setDownloading(docType);
    try {
      await downloadPayrollDocument(run.id, docType, extras);
      toast({ title: `${label} downloaded successfully` });
    } catch (err: any) {
      console.error("Download failed:", err);
      toast({ title: `Failed to download ${label}`, description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  };

  const handlePostToGL = async () => {
    if (onPostToGL) {
      setLocalPosting(true);
      try {
        await onPostToGL(run);
      } finally {
        setLocalPosting(false);
      }
    } else {
      // Fallback: use hook directly
      setLocalPosting(true);
      try {
        await postPayrollToGL(run);
        toast({ title: "Payroll posted to General Ledger successfully" });
        // Cascade-invalidate so liability ledger / returns / Finance JE list refresh.
        queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
        queryClient.invalidateQueries({ queryKey: ["payroll-liabilities"] });
        queryClient.invalidateQueries({ queryKey: ["payroll-return-runs"] });
        queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      } catch (err: any) {
        toast({ title: "Failed to post to GL", description: normalizeError(err).message, variant: "destructive" });
      } finally {
        setLocalPosting(false);
      }
    }
  };


  const hasBlockerIssues = runIssues.some((i) => i.severity === "blocker");
  const blockerCount = runIssues.filter((i) => i.severity === "blocker").length;
  const hasCriticalMappingIssue = criticalMappingFindings.length > 0;
  // SoD-gated lifecycle actions — each step requires its own granular permission.
  const canPostGL = (run.status === "approved" || run.status === "processed") && canPostPayrollGL && !hasBlockerIssues && !hasCriticalMappingIssue;
  const canApprove = run.status === "draft" && canApprovePayroll && !hasBlockerIssues;
  const canMarkPaid = run.status === "posted" && canPayPayroll;
  const canDelete = (run.status === "draft" || run.status === "approved") && canRunPayroll && !!onDelete;
  const requiresTypedConfirm = run.status !== "draft";
  const typedMatches = !requiresTypedConfirm || typedConfirm.trim() === run.payroll_number;
  const hasJournalEntry = run.status === "posted" || run.status === "paid";

  const openDeleteConfirm = () => {
    setTypedConfirm("");
    setConfirmDelete(true);
  };

  const handleDeleteConfirmed = async () => {
    if (!onDelete || !run || !typedMatches) return;
    setIsDeleting(true);
    try {
      await onDelete(run);
      setConfirmDelete(false);
      setTypedConfirm("");
      onOpenChange(false);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0 gap-0 w-full sm:max-w-4xl overflow-hidden">
        <SheetHeader className="flex-shrink-0 px-6 py-4 border-b max-h-[55dvh] sm:max-h-[50vh] overflow-y-auto">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 pr-8">
            <div className="min-w-0">
              <SheetTitle className="text-lg sm:text-xl truncate">{run.payroll_number}</SheetTitle>
              <SheetDescription className="break-words">
                {periodLabel} • {run.employee_count} employees
                {run.run_type === "correction" && run.original_run_id && (
                  <>
                    {" • "}
                    <span className="text-xs">Signed delta vs parent run </span>
                    <Link
                      to={`/hr/payroll/runs?run=${run.original_run_id}`}
                      className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                    >
                      {run.original_run_id.slice(0, 8)}…
                    </Link>
                  </>
                )}
              </SheetDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {getStatusBadge(run.status)}
              {(() => {
                const badge = getLineageBadge(run);
                return badge ? (
                  <Badge variant={badge.variant} className="text-[10px]">{badge.label}</Badge>
                ) : null;
              })()}
              {runIssues.length > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" /> {runIssues.length} issue{runIssues.length === 1 ? "" : "s"}
                </Badge>
              )}
              {hasJournalEntry && (
                <Badge variant="outline" className="gap-1">
                  <BookOpen className="h-3 w-3" /> GL Posted
                </Badge>
              )}
            </div>
          </div>

          {/* Action buttons row */}
          <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t">
            {/* Reports Dropdown */}
            {payslips.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={!!downloading}>
                    {downloading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
                    Reports <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Payroll Reports</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => handleDownload("payroll_register", "Payroll Register")}>
                    <FileText className="h-4 w-4 mr-2" /> Full Register (CSV)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleDownload("payroll_summary_excel", "Summary Excel")}>
                    <FileText className="h-4 w-4 mr-2" /> Summary (CSV)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleDownload("payroll_summary_pdf", "Summary PDF")}>
                    <FileText className="h-4 w-4 mr-2" /> Summary (PDF)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Banking</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => handleDownload("bank_payment_file", "Bank File", { bank_file_format: "generic_csv" })}>
                    <FileText className="h-4 w-4 mr-2" /> Bank Transfer File (Legacy)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    downloadBankSchedule(payslips, run.payroll_number);
                    toast({ title: "Bank transfer schedule downloaded" });
                  }}>
                    <Banknote className="h-4 w-4 mr-2" /> Bank Transfer Schedule (CSV)
                  </DropdownMenuItem>

                  {returnTemplates.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Statutory Returns</DropdownMenuLabel>
                      <DropdownMenuItem asChild>
                        <Link to="/hr/remittances">
                          <FileText className="h-4 w-4 mr-2" />
                          Manage statutory returns ({returnTemplates.length})
                        </Link>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Bulk Payslip Download */}
            {payslips.length > 0 && run.status !== "draft" && (
              <Button variant="outline" size="sm" disabled={downloading === "bulk-payslips"}
                onClick={async () => {
                  setDownloading("bulk-payslips");
                  let successCount = 0;
                  try {
                    for (const ps of payslips) {
                      const empName = ps.employee ? `${ps.employee.first_name}_${ps.employee.last_name}` : "payslip";
                      await downloadPayslipPdf(run.id, ps.id, `${empName}_${run.payroll_number}.pdf`);
                      successCount++;
                      // Small delay to prevent browser blocking multiple downloads
                      await new Promise(r => setTimeout(r, 500));
                    }
                    toast({ title: `Downloaded ${successCount} payslips` });
                  } catch {
                    toast({ title: `Downloaded ${successCount}/${payslips.length} payslips`, description: "Some downloads failed.", variant: "destructive" });
                  } finally {
                    setDownloading(null);
                  }
                }}>
                {downloading === "bulk-payslips" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <FileDown className="h-3 w-3 mr-1" />}
                Download All Payslips
              </Button>
            )}

            {/* Email Payslips — unified SendDocumentDialog in bulk mode */}
            {payslips.length > 0 && run.status !== "draft" && canEmailPayslips && (
              <Button variant="outline" size="sm" onClick={() => setShowBulkEmail(true)}>
                <Mail className="h-3 w-3 mr-1" />
                Email All Payslips
              </Button>
            )}

            <div className="flex-1" />

            {/* Workflow actions — gated when blocker-severity diagnostics exist */}
            <TooltipProvider delayDuration={150}>
            {canApprove && onApprove && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" variant="outline" onClick={() => onApprove(run)} disabled={hasBlockerIssues}>
                      <CheckCircle className="h-3 w-3 mr-1" /> Approve
                    </Button>
                  </span>
                </TooltipTrigger>
                {hasBlockerIssues && (
                  <TooltipContent>Resolve {blockerCount} blocker issue{blockerCount === 1 ? "" : "s"} before approving.</TooltipContent>
                )}
              </Tooltip>
            )}

            {canPostGL && !hasJournalEntry && (
              <>
                {/* Preview posting — run-scoped, read-only projection. Never
                    mutates ledger state. Enabled from `computed` and
                    `approved` alongside real post so accountants can
                    validate the JE before authorising. */}
                <PayrollPostingPreviewDialog
                  runId={run.id}
                  organizationId={run.organization_id}
                  businessId={run.business_id ?? null}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button size="sm" variant="outline" onClick={handlePostToGL} disabled={isPostingGL || hasBlockerIssues || hasCriticalMappingIssue}>
                        {isPostingGL ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <BookOpen className="h-3 w-3 mr-1" />}
                        Post to GL
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {hasBlockerIssues && (
                    <TooltipContent>Resolve {blockerCount} blocker issue{blockerCount === 1 ? "" : "s"} before posting to the general ledger.</TooltipContent>
                  )}
                  {!hasBlockerIssues && hasCriticalMappingIssue && (
                    <TooltipContent>Resolve {criticalMappingFindings.length} critical GL mapping issue{criticalMappingFindings.length === 1 ? "" : "s"} before posting.</TooltipContent>
                  )}
                </Tooltip>
              </>
            )}
            </TooltipProvider>

            {canMarkPaid && onMarkPaid && (
              <Button size="sm" onClick={() => onMarkPaid(run)}>
                <DollarSign className="h-3 w-3 mr-1" /> Mark Paid
              </Button>
            )}

            {canPostPayrollGL && onReverse && canReverseRun(run).allowed && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => onReverse(run)}
                title="Reverse run"
              >
                <RotateCcw className="h-3 w-3 mr-1" /> Reverse
              </Button>
            )}

            {canDelete && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={openDeleteConfirm}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                {run.status === "draft" ? "Delete draft" : "Delete approved run"}
              </Button>
            )}
          </div>
        </SheetHeader>

        <Tabs defaultValue="overview" className="mt-0 min-w-0 flex-1 min-h-0 flex flex-col">
          <TabsList className="w-full sm:w-auto mx-6 mt-3 self-start flex-shrink-0">
            <TabsTrigger value="overview" className="flex-1 sm:flex-none">Overview</TabsTrigger>
            <TabsTrigger value="rule_set" className="flex-1 sm:flex-none">Rule Set</TabsTrigger>
            <TabsTrigger value="audit" className="flex-1 sm:flex-none">Audit Trail</TabsTrigger>
          </TabsList>
          <TabsContent value="rule_set" className="flex-1 min-h-0 mt-2">
            <ScrollArea className="h-full px-6 pb-4">
              <PayrollRuleSetPanel payrollRunId={run.id} />
            </ScrollArea>
          </TabsContent>
          <TabsContent value="audit" className="flex-1 min-h-0 mt-2">
            <ScrollArea className="h-full px-6 pb-4">
              <PayrollAuditTrail runId={run.id} payslipIds={payslips.map((p) => p.id)} />
            </ScrollArea>
          </TabsContent>
          <TabsContent value="overview" className="flex-1 min-h-0 mt-2">
        <ScrollArea className="h-full px-6 pb-4">
          <div className="space-y-4">
            {/* Wave-3.1 — payroll GL mapping findings + reclass CTA, scoped to this run. */}
            <PayrollMappingFindingsPanel
              payrollRun={{ id: run.id, payroll_number: run.payroll_number, status: run.status }}
            />
            {/* Issues panel — surfaces compute-payroll skip-sink warnings */}
            {runIssues.length > 0 && (
              <Card className="border-destructive/40">
                <CardHeader className="p-3 pb-1 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-sm flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    Run Issues ({runIssues.length})
                  </CardTitle>
                  <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                    <Link to="/hr/payroll/statutory-rules">Open Statutory Rules →</Link>
                  </Button>
                </CardHeader>
                <CardContent className="p-3 pt-1 space-y-2">
                  {runIssues.map((iss) => {
                    const ruleName = iss.details?.rule_name || iss.details?.rule_type || null;
                    const ruleId = iss.details?.rule_id || null;
                    const empLabel = iss.employee_id
                      ? (`${iss.employee_first_name ?? ""} ${iss.employee_last_name ?? ""}`.trim() +
                        (iss.employee_number ? ` (${iss.employee_number})` : ""))
                      : null;
                    const isBlocker = iss.severity === "blocker";
                    return (
                      <div key={iss.id} className={`text-sm border-l-2 ${isBlocker ? "border-destructive" : "border-destructive/60"} pl-2 py-1`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={isBlocker ? "destructive" : "outline"} className="text-[10px] uppercase">{iss.severity}</Badge>
                          {empLabel && <span className="font-medium">{empLabel}</span>}
                          {ruleName && <span className="font-medium">{ruleName}</span>}
                          <span className="font-mono text-xs text-muted-foreground">{iss.code}</span>
                        </div>
                        <p className="mt-1 text-foreground">{iss.message}</p>
                        {ruleId && (
                          <Link
                            to={`/hr/payroll/statutory-rules?focus=${ruleId}`}
                            className="text-xs text-primary hover:underline"
                          >
                            Fix this rule →
                          </Link>
                        )}
                        {iss.code === "TIMESHEETS_NOT_APPROVED" && iss.employee_id && (
                          <Link
                            to={`/hr/timesheets?employee=${iss.employee_id}`}
                            className="text-xs text-primary hover:underline"
                          >
                            Review timesheets →
                          </Link>
                        )}
                        {!isBlocker && canRunPayroll && (
                          <button
                            type="button"
                            onClick={() => { setDismissTarget({ id: iss.id, code: iss.code, message: iss.message }); setDismissReason(""); }}
                            className="ml-2 text-xs text-muted-foreground hover:text-foreground underline"
                          >
                            Dismiss…
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground pt-1">
                    Blockers excluded the affected employees from this run. Warnings indicate rules the engine could not apply.
                  </p>
                </CardContent>
              </Card>
            )}
            <AlertDialog open={!!dismissTarget} onOpenChange={(v) => { if (!v) setDismissTarget(null); }}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Dismiss diagnostic</AlertDialogTitle>
                  <AlertDialogDescription>
                    Provide a reason (≥10 characters). This is recorded against the run for audit.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div className="font-mono">{dismissTarget?.code}</div>
                  <div>{dismissTarget?.message}</div>
                </div>
                <Textarea
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  placeholder="e.g. Confirmed with finance — rule will be re-seeded next pack release."
                  rows={3}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={dismissReason.trim().length < 10 || dismissMutation.isPending}
                    onClick={() => dismissTarget && dismissMutation.mutate({ id: dismissTarget.id, reason: dismissReason })}
                  >
                    {dismissMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    Dismiss with reason
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {/* Summary Cards */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <Card><CardHeader className="p-3 pb-1"><CardTitle className="text-xs text-muted-foreground">Total Gross</CardTitle></CardHeader>
                <CardContent className="p-3 pt-0"><p className="text-base sm:text-xl font-bold break-words">{formatCurrency(run.total_gross)}</p></CardContent></Card>
              <Card><CardHeader className="p-3 pb-1"><CardTitle className="text-xs text-muted-foreground">Total Deductions</CardTitle></CardHeader>
                <CardContent className="p-3 pt-0"><p className="text-base sm:text-xl font-bold text-destructive break-words">{formatCurrency(
                  Object.values(run.deductions_summary || {}).reduce((s, v) => s + (v || 0), 0) ||
                  (run.total_other_deductions || 0)
                )}</p></CardContent></Card>
              <Card><CardHeader className="p-3 pb-1"><CardTitle className="text-xs text-muted-foreground">Employer Contributions</CardTitle></CardHeader>
                <CardContent className="p-3 pt-0"><p className="text-base sm:text-xl font-bold text-muted-foreground break-words">{formatCurrency(
                  Object.values(run.contributions_summary || {}).reduce((s, v) => s + (v || 0), 0)
                )}</p></CardContent></Card>
              <Card><CardHeader className="p-3 pb-1"><CardTitle className="text-xs text-muted-foreground">Total Net Pay</CardTitle></CardHeader>
                <CardContent className="p-3 pt-0"><p className="text-base sm:text-xl font-bold text-primary break-words">{formatCurrency(run.total_net)}</p></CardContent></Card>
            </div>

            {/* Deductions & Contributions Breakdown */}
            {run.deductions_summary && Object.keys(run.deductions_summary).length > 0 && (
              <div className="grid gap-3 md:grid-cols-2">
                <Card>
                  <CardHeader className="p-3 pb-1"><CardTitle className="text-sm">Deductions Breakdown</CardTitle></CardHeader>
                  <CardContent className="p-3 pt-1 space-y-1">
                    {Object.entries(run.deductions_summary).filter(([, v]) => v > 0).map(([key, val]) => {
                      const gm = key.match(/^garnishment_([0-9a-f-]{8,})$/i);
                      const display = gm ? `Legal Order (${gm[1].slice(0, 8)}…)` : key.replace(/_/g, " ");
                      return (
                        <div key={key} className="flex justify-between text-sm">
                          <span className="text-muted-foreground capitalize">{display}</span>
                          <span>{formatCurrency(val)}</span>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
                {run.contributions_summary && Object.keys(run.contributions_summary).length > 0 && (
                  <Card>
                    <CardHeader className="p-3 pb-1"><CardTitle className="text-sm">Employer Contributions</CardTitle></CardHeader>
                    <CardContent className="p-3 pt-1 space-y-1">
                      {Object.entries(run.contributions_summary).filter(([, v]) => v > 0).map(([key, val]) => (
                        <div key={key} className="flex justify-between text-sm">
                          <span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
                          <span>{formatCurrency(val)}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            <Separator />

            {/* Employee Payslips Table — Payroll Register */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold">Payroll Register ({payslips.length})</h4>
                {payslips.length > 0 && (
                  <ReportExportButtons
                    compact
                    formats={["excel", "csv", "pdf"]}
                    getExportConfig={() => getPayrollRegisterExportConfig(run, payslips, formatCurrency, currentOrg?.id)}
                  />
                )}
              </div>
              {isLoadingPayslips ? (
                <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : payslips.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No payslips found.</p>
              ) : (
                <>
                  {/* Mobile card list */}
                  <div className="sm:hidden flex flex-col gap-2">
                    {payslips.map((ps) => {
                      const empName = ps.employee ? `${ps.employee.first_name} ${ps.employee.last_name}` : "Unknown";
                      return (
                        <div key={ps.id} className="p-3 border rounded-lg space-y-2 bg-card">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-medium truncate">{empName}</p>
                              <div className="flex items-center gap-1 mt-1 flex-wrap">
                                <Badge className={`${ps.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-yellow-100 text-yellow-800"}`}>
                                  {ps.status}
                                </Badge>
                                {ps.retro_of_payslip_id && (
                                  <Badge variant="secondary" className="text-[10px]">
                                    Δ vs parent
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <Button variant="ghost" size="icon" title="Download Payslip PDF" className="shrink-0"
                              disabled={downloading === `payslip-${ps.id}`}
                              onClick={async () => {
                                setDownloading(`payslip-${ps.id}`);
                                try {
                                  const fn = ps.employee ? `${ps.employee.first_name}_${ps.employee.last_name}` : "payslip";
                                  await downloadPayslipPdf(run.id, ps.id, `${fn}_${run.payroll_number}.pdf`);
                                } catch {
                                  toast({ title: "Failed to generate payslip PDF", variant: "destructive" });
                                } finally {
                                  setDownloading(null);
                                }
                              }}>
                              {downloading === `payslip-${ps.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            </Button>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t">
                            <div>
                              <p className="text-muted-foreground">Gross</p>
                              <p className="font-medium break-words">{formatCurrency(ps.gross_pay)}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Deductions</p>
                              <p className="font-medium text-destructive break-words">{formatCurrency(ps.total_deductions)}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Net Pay</p>
                              <p className="font-bold text-primary break-words">{formatCurrency(ps.net_pay)}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop table */}
                  <div className="hidden sm:block overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Employee</TableHead>
                          <TableHead className="text-right">Gross</TableHead>
                          <TableHead className="text-right">Deductions</TableHead>
                          <TableHead className="text-right font-bold">Net Pay</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {payslips.map((ps) => (
                          <TableRow key={ps.id}>
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                <span>{ps.employee ? `${ps.employee.first_name} ${ps.employee.last_name}` : "Unknown"}</span>
                                {ps.retro_of_payslip_id && (
                                  <Badge variant="secondary" className="text-[10px]" title="Signed delta vs parent payslip">
                                    Δ
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className={`text-right ${ps.gross_pay < 0 ? "text-destructive" : ""}`}>{formatCurrency(ps.gross_pay)}</TableCell>
                            <TableCell className={`text-right ${ps.total_deductions < 0 ? "text-destructive" : ""}`}>{formatCurrency(ps.total_deductions)}</TableCell>
                            <TableCell className={`text-right font-bold ${ps.net_pay < 0 ? "text-destructive" : ""}`}>{formatCurrency(ps.net_pay)}</TableCell>
                            <TableCell>
                              <Badge className={ps.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-yellow-100 text-yellow-800"}>
                                {ps.status}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Button variant="ghost" size="icon" title="Download Payslip PDF"
                                disabled={downloading === `payslip-${ps.id}`}
                                onClick={async () => {
                                  setDownloading(`payslip-${ps.id}`);
                                  try {
                                    const empName = ps.employee ? `${ps.employee.first_name}_${ps.employee.last_name}` : "payslip";
                                    await downloadPayslipPdf(run.id, ps.id, `${empName}_${run.payroll_number}.pdf`);
                                  } catch {
                                    toast({ title: "Failed to generate payslip PDF", variant: "destructive" });
                                  } finally {
                                    setDownloading(null);
                                  }
                                }}>
                                {downloading === `payslip-${ps.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </div>
          </div>
        </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
      {showBulkEmail && (
        <SendDocumentDialog
          open={showBulkEmail}
          onOpenChange={setShowBulkEmail}
          bulk={{
            documentType: "payslip",
            documentIds: payslips.map((p) => p.id),
            scopeLabel: run.payroll_number,
          }}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={(o) => { setConfirmDelete(o); if (!o) setTypedConfirm(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {requiresTypedConfirm && <AlertTriangle className="h-5 w-5 text-destructive" />}
              {run.status === "draft" ? "Delete draft payroll run?" : "Delete approved payroll run?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This permanently removes <span className="font-medium text-foreground">{run.payroll_number}</span>
                  {" "}and all its payslips ({run.employee_count} employee{run.employee_count === 1 ? "" : "s"}).
                  {" "}This action cannot be undone.
                </p>
                {requiresTypedConfirm ? (
                  <p className="text-destructive">
                    This run has been <span className="font-semibold">approved</span> but has
                    <span className="font-semibold"> not yet been posted to the General Ledger</span>.
                    Once posted or paid, deletion is no longer allowed — you must reverse the run instead.
                  </p>
                ) : (
                  <p>Approved, posted, or paid runs must be reversed instead.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {requiresTypedConfirm && (
            <div className="space-y-2">
              <Label htmlFor="payroll-detail-delete-confirm">
                Type <span className="font-mono font-semibold">{run.payroll_number}</span> to confirm
              </Label>
              <Input
                id="payroll-detail-delete-confirm"
                autoComplete="off"
                autoFocus
                value={typedConfirm}
                onChange={(e) => setTypedConfirm(e.target.value)}
                placeholder={run.payroll_number}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDeleteConfirmed(); }}
              disabled={isDeleting || !typedMatches}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              {run.status === "draft" ? "Delete draft" : "Delete approved run"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
