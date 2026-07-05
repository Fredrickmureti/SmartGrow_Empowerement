import { useState, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle, CheckCircle, Eye, FileText } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import { printPdfInPage, downloadPdfBlob } from "@/services/printing/pdfUtils";
import { SafePdfViewer } from "@/components/common/SafePdfViewer";

interface PreviewPayslip {
  employee_id: string;
  _employee_name: string;
  _employee_number: string;
  _salary_source: string;
  _proration_factor: number;
  // Phase 4 P1.2c: preview mirrors engine output — header carries only
  // universal totals. Component-level breakdown surfaces through
  // deductions_detail / contributions_detail (keyed by pack rule_code).
  gross_pay: number;
  total_deductions: number;
  net_pay: number;
  unpaid_leave_days: number;
  leave_deduction: number;
  deductions_detail: Record<string, number>;
  contributions_detail: Record<string, number>;
}

interface PreviewData {
  dry_run: boolean;
  employee_count: number;
  total_gross: number;
  total_net: number;
  deductions_summary: Record<string, number>;
  contributions_summary: Record<string, number>;
  payslips: PreviewPayslip[];
  warnings: string[];
}

interface PayrollPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  previewData: PreviewData | null;
  isLoading: boolean;
  onConfirm: () => void;
  isConfirming: boolean;
  periodLabel?: string;
  /** Per-employee proration overrides currently applied to this draft. */
  prorationOverrides?: Record<string, { full_period: boolean; reason: string }>;
  /** Apply or update a full-period override for a prorated employee. */
  onOverrideProration?: (employeeId: string, reason: string) => void | Promise<void>;
  /** Remove an existing override and revert to computed proration. */
  onClearOverride?: (employeeId: string) => void | Promise<void>;
}

export function PayrollPreviewDialog({
  open,
  onOpenChange,
  previewData,
  isLoading,
  onConfirm,
  isConfirming,
  periodLabel,
  prorationOverrides,
  onOverrideProration,
  onClearOverride,
}: PayrollPreviewDialogProps) {
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const [showWarnings, setShowWarnings] = useState(true);
  // ADR-0015 — SafePdfViewer owns the blob URL; we only hold the raw Blob
  // so Print / Download / re-open in dedicated window can reuse it.
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  // Inline reason prompt for proration override. Keyed by employee_id.
  const [overrideTarget, setOverrideTarget] = useState<{ id: string; name: string } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  const formatLabel = (key: string) => key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  const buildPdfPayload = useCallback(() => {
    if (!previewData) return null;

    // Build unique deduction keys across all payslips
    const allDeductionKeys = new Set<string>();
    previewData.payslips.forEach(ps => {
      Object.keys(ps.deductions_detail || {}).forEach(k => allDeductionKeys.add(k));
    });
    const deductionKeys = Array.from(allDeductionKeys);

    const columns = [
      { key: "employee", header: "Employee", width: 20, format: "text" },
      { key: "emp_no", header: "Emp #", width: 10, format: "text" },
      { key: "gross_pay", header: "Gross Pay", width: 14, format: "currency", align: "right" as const },
      ...deductionKeys.map(k => ({
        key: `ded_${k}`,
        header: formatLabel(k),
        width: 12,
        format: "currency" as const,
        align: "right" as const,
      })),
      { key: "total_deductions", header: "Total Deductions", width: 14, format: "currency", align: "right" as const },
      { key: "net_pay", header: "Net Pay", width: 14, format: "currency", align: "right" as const },
    ];

    const rows = previewData.payslips.map(ps => {
      const row: Record<string, string | number | boolean | null | undefined> = {
        employee: ps._employee_name,
        emp_no: ps._employee_number,
        gross_pay: ps.gross_pay,
        total_deductions: ps.total_deductions,
        net_pay: ps.net_pay,
      };
      deductionKeys.forEach(k => {
        row[`ded_${k}`] = ps.deductions_detail?.[k] || 0;
      });
      return row;
    });

    // Add grand total row
    rows.push({
      employee: "TOTAL",
      emp_no: "",
      gross_pay: previewData.total_gross,
      total_deductions: previewData.total_gross - previewData.total_net,
      net_pay: previewData.total_net,
      _isGrandTotal: true,
      ...Object.fromEntries(deductionKeys.map(k => [
        `ded_${k}`,
        previewData.payslips.reduce((s, p) => s + (p.deductions_detail?.[k] || 0), 0),
      ])),
    });

    return {
      title: `Payroll Register Preview`,
      subtitle: periodLabel ? `Pay Period: ${periodLabel}` : "Dry Run — Not Yet Created",
      columns,
      rows,
      orientation: "landscape" as const,
    };
  }, [previewData, periodLabel, formatLabel]);

  const handlePreviewPdf = async () => {
    const payload = buildPdfPayload();
    if (!payload) return;

    setIsGeneratingPdf(true);
    try {
      // Stage C: route through the canonical render-report funnel.
      // Branding (logo, company name, address, currency) is resolved
      // server-side from `getOrganizationBranding(organizationId)` —
      // no companyName / currency override is sent on the wire.
      const { data, error } = await supabase.functions.invoke("render-report", {
        body: {
          ...payload,
          organizationId: currentOrg?.id,
        },
        headers: { "Content-Type": "application/json" },
      });
      if (error) throw error;
      const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
      setPdfBlob(blob);
      setShowPdfPreview(true);
    } catch (err: any) {
      console.error("Failed to generate payroll preview PDF:", err);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleDownloadPdf = () => {
    if (pdfBlob) {
      downloadPdfBlob(pdfBlob, `payroll-register-preview.pdf`);
    }
  };

  const handlePrintPdf = async () => {
    if (pdfBlob) {
      await printPdfInPage(pdfBlob);
    }
  };

  // Cleanup on close
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setPdfBlob(null);
      setShowPdfPreview(false);
    }
    onOpenChange(isOpen);
  };

  if (isLoading) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
          <div className="flex flex-col items-center justify-center py-12 gap-3 flex-1">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Computing payroll preview...</p>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (!previewData) return null;

  const totalDeductions = previewData.total_gross - previewData.total_net;

  // PDF Preview mode
  if (showPdfPreview && pdfBlob) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="w-[95vw] max-w-5xl h-[95dvh] sm:h-[85vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-lg">Payroll Register Preview (PDF)</DialogTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowPdfPreview(false)}>
                  Back to Data
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
                  Download PDF
                </Button>
                <Button variant="outline" size="sm" onClick={handlePrintPdf}>
                  Print
                </Button>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden bg-muted/30 p-4">
            <SafePdfViewer
              pdfBlob={pdfBlob}
              title="Payroll Register Preview"
              filename="payroll-register-preview"
              className="w-full h-full bg-background rounded-lg shadow-lg border overflow-hidden flex flex-col"
            />
          </div>
          <div className="px-6 py-4 border-t flex-shrink-0 flex justify-end gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={isConfirming}>
              {isConfirming ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle className="mr-2 h-4 w-4" />
              )}
              Confirm & Create Payroll
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex flex-col p-0 gap-0 w-[95vw] max-w-4xl h-[95dvh] sm:h-[90vh] overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Payroll Preview (Dry Run)
          </DialogTitle>
          <DialogDescription>
            Review the computed payroll before creating. No data has been saved yet.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-4 px-6 py-4">
            {/* Summary Cards */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-xs text-muted-foreground">Employees</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-xl font-bold">{previewData.employee_count}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-xs text-muted-foreground">Total Gross</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-xl font-bold">{formatCurrency(previewData.total_gross)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-xs text-muted-foreground">Total Deductions</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-xl font-bold text-destructive">{formatCurrency(totalDeductions)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-xs text-muted-foreground">Total Net</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-xl font-bold text-primary">{formatCurrency(previewData.total_net)}</p>
                </CardContent>
              </Card>
            </div>

            {/* Deductions Breakdown */}
            {Object.keys(previewData.deductions_summary).length > 0 && (
              <Card>
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-sm">Deductions Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <div className="grid gap-1">
                    {Object.entries(previewData.deductions_summary).map(([key, value]) => (
                      <div key={key} className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{formatLabel(key)}</span>
                        <span className="font-medium">{formatCurrency(value)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Warnings */}
            {previewData.warnings.length > 0 && (
              <Card className="border-yellow-200 dark:border-yellow-800">
                <CardHeader className="p-3 pb-2 cursor-pointer" onClick={() => setShowWarnings(!showWarnings)}>
                  <CardTitle className="text-sm flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
                    <AlertTriangle className="h-4 w-4" />
                    {previewData.warnings.length} Warning{previewData.warnings.length > 1 ? "s" : ""}
                  </CardTitle>
                </CardHeader>
                {showWarnings && (
                  <CardContent className="p-3 pt-0">
                    <ul className="space-y-1">
                      {previewData.warnings.map((w, i) => (
                        <li key={i} className="text-xs text-yellow-700 dark:text-yellow-400">• {w}</li>
                      ))}
                    </ul>
                  </CardContent>
                )}
              </Card>
            )}

            {/* Employee Breakdown Table */}
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm">Employee Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Employee</TableHead>
                      <TableHead className="text-xs">Source</TableHead>
                      <TableHead className="text-xs text-right">Gross</TableHead>
                      <TableHead className="text-xs text-right">Deductions</TableHead>
                      <TableHead className="text-xs text-right">Net Pay</TableHead>
                      <TableHead className="text-xs">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewData.payslips.map((ps) => (
                      <TableRow key={ps.employee_id}>
                        <TableCell className="text-xs">
                          <div className="font-medium">{ps._employee_name}</div>
                          <div className="text-muted-foreground">{ps._employee_number}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={ps._salary_source === "contract" ? "default" : "secondary"} className="text-[10px]">
                            {ps._salary_source === "contract" ? "Contract" : "Master"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(ps.gross_pay)}</TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(ps.total_deductions)}</TableCell>
                        <TableCell className="text-xs text-right font-bold">{formatCurrency(ps.net_pay)}</TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap items-center gap-1">
                            {ps._proration_factor < 1 && (
                              <Badge variant="outline" className="text-[10px]">
                                {(ps._proration_factor * 100).toFixed(0)}% prorated
                              </Badge>
                            )}
                            {prorationOverrides?.[ps.employee_id]?.full_period && (
                              <Badge variant="secondary" className="text-[10px]" title={prorationOverrides[ps.employee_id].reason}>
                                Full-period override
                              </Badge>
                            )}
                            {ps.unpaid_leave_days > 0 && (
                              <Badge variant="outline" className="text-[10px]">
                                {ps.unpaid_leave_days}d leave
                              </Badge>
                            )}
                            {onOverrideProration && ps._proration_factor < 1 && !prorationOverrides?.[ps.employee_id]?.full_period && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 px-1 text-[10px]"
                                onClick={() => { setOverrideTarget({ id: ps.employee_id, name: ps._employee_name }); setOverrideReason(""); }}
                              >
                                Override
                              </Button>
                            )}
                            {onClearOverride && prorationOverrides?.[ps.employee_id]?.full_period && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 px-1 text-[10px]"
                                onClick={() => onClearOverride(ps.employee_id)}
                              >
                                Clear
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>

        {/* Sticky footer — always visible on mobile/laptop */}
        <div className="px-6 py-4 border-t flex-shrink-0 flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
          <Button
            variant="outline"
            onClick={handlePreviewPdf}
            disabled={isGeneratingPdf}
            className="w-full sm:w-auto"
          >
            {isGeneratingPdf ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileText className="mr-2 h-4 w-4" />
            )}
            Preview PDF
          </Button>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={isConfirming} className="w-full sm:w-auto">
              {isConfirming ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle className="mr-2 h-4 w-4" />
              )}
              Confirm & Create Payroll
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {/* Override reason prompt — gates the override behind an audit reason. */}
    <Dialog open={!!overrideTarget} onOpenChange={(o) => { if (!o) setOverrideTarget(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Override proration</DialogTitle>
          <DialogDescription>
            Force {overrideTarget?.name} to receive their full contract amount for this period instead of the auto-prorated amount. The reason is recorded on the payslip and the run audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="override-reason">Reason</Label>
          <Textarea
            id="override-reason"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="e.g. Policy: first payroll covers full month regardless of hire date."
            rows={3}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOverrideTarget(null)}>Cancel</Button>
          <Button
            disabled={!overrideReason.trim()}
            onClick={async () => {
              if (overrideTarget && onOverrideProration) {
                await onOverrideProration(overrideTarget.id, overrideReason.trim());
              }
              setOverrideTarget(null);
              setOverrideReason("");
            }}
          >
            Apply override
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
