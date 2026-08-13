/**
 * Print Preview Dialog Component (Financial Reports)
 * 
 * Shows the ACTUAL server-generated PDF in an iframe preview.
 * This ensures preview matches final output exactly (no HTML approximation).
 * Caches the PDF blob so Print/Download reuse it without re-generating.
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, X, Download, FileDown, Loader2 } from "lucide-react";
import { exportToExcel, type ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { printPdfInPage, downloadPdfBlob } from "@/services/printing/pdfUtils";
import { SafePdfViewer } from "@/components/common/SafePdfViewer";

interface ReportPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** May be async — server-paginated reports resolve the full dataset here. */
  getExportConfig: () => ExportConfig | Promise<ExportConfig>;
}

export function ReportPreviewDialog({
  open,
  onOpenChange,
  getExportConfig,
}: ReportPreviewDialogProps) {
  const [config, setConfig] = useState<ExportConfig | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ADR-0015 — SafePdfViewer owns the blob URL lifecycle. We only manage
  // the raw Blob here so Print / Download / re-render can reuse it.
  useEffect(() => {
    if (!open) {
      setPdfBlob(null);
      setConfig(null);
      setErrorMsg(null);
      return;
    }

    const cfg = getExportConfig();
    cfg.generatedAt = new Date();
    setConfig(cfg);
    setIsLoading(true);

    // Stage 2: call the canonical render-report endpoint. Deprecated
    // wire fields (companyName / explicit org override) are no longer
    // sent — branding is resolved server-side. When the config carries
    // server-build hints (reportType + dateFrom + dateTo), forward them
    // so the engine can fetch and render in one round-trip.
    const sb = (cfg as unknown as {
      reportType?: string;
      dateFrom?: string;
      dateTo?: string;
      filters?: Record<string, unknown>;
      businessId?: string;
    });
    const payload: Record<string, unknown> = sb.reportType && sb.dateFrom && sb.dateTo
      ? {
          reportType: sb.reportType,
          dateFrom: sb.dateFrom,
          dateTo: sb.dateTo,
          filters: sb.filters ?? {},
          organizationId: (cfg as unknown as { organizationId?: string }).organizationId,
          businessId: sb.businessId,
          title: cfg.title,
          currency: cfg.currency,
        }
      : {
          title: cfg.title,
          subtitle: cfg.subtitle,
          dateRange: cfg.dateRange,
          columns: cfg.columns,
          rows: cfg.rows,
          currency: cfg.currency,
          orientation: "landscape" as const,
          organizationId: (cfg as unknown as { organizationId?: string }).organizationId,
        };

    setErrorMsg(null);
    supabase.functions
      .invoke("render-report", {
        body: payload,
        headers: { "Content-Type": "application/json" },
      })
      .then(async ({ data, error }) => {
        if (error) {
          // Try to extract structured error from edge response
          let detail = error.message || "Failed to generate preview";
          try {
            const ctx = (error as unknown as { context?: Response }).context;
            if (ctx && typeof ctx.text === "function") {
              const txt = await ctx.text();
              try {
                const j = JSON.parse(txt);
                detail = j.error || j.message || detail;
              } catch { detail = txt || detail; }
            }
          } catch { /* ignore */ }
          throw new Error(detail);
        }
        const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
        setPdfBlob(blob);
      })
      .catch((err) => {
        console.error("Failed to generate report PDF preview:", err);
        setErrorMsg(err?.message ?? String(err));
      })
      .finally(() => setIsLoading(false));
  }, [open, getExportConfig]);

  const handlePrint = async () => {
    if (!pdfBlob) return;
    setIsPrinting(true);
    try {
      await printPdfInPage(pdfBlob);
    } catch (error) {
      console.error("Print failed:", error);
    } finally {
      setIsPrinting(false);
    }
  };

  const handleDownloadPDF = () => {
    if (!pdfBlob || !config) return;
    const filename = config.title.replace(/[^a-zA-Z0-9_-]/g, "_");
    downloadPdfBlob(pdfBlob, `${filename}.pdf`);
  };

  const handleDownloadExcel = async () => {
    if (config) {
      await exportToExcel(config);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0 no-print">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg">Print Preview — {config?.title}</DialogTitle>
          </div>
        </DialogHeader>

        <div className="print-content flex-1 overflow-hidden bg-muted/30 p-6">
          <div className="h-full w-full">
            {errorMsg && !pdfBlob && !isLoading ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
                <span className="text-sm font-medium mb-1">Failed to generate preview</span>
                <span className="text-xs text-destructive max-w-md break-words">{errorMsg}</span>
              </div>
            ) : (
              <SafePdfViewer
                pdfBlob={pdfBlob}
                isLoading={isLoading}
                title={config?.title ? `Print Preview — ${config.title}` : "Print Preview"}
                filename={(config?.title ?? "report").replace(/[^a-zA-Z0-9_-]/g, "_")}
                className="h-full w-full bg-background rounded-lg shadow-lg border overflow-hidden flex flex-col"
              />
            )}
          </div>
        </div>


        <DialogFooter className="px-6 py-4 border-t flex-shrink-0 no-print">
          <div className="flex items-center gap-2 w-full justify-between">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleDownloadPDF} disabled={!pdfBlob}>
                <FileDown className="h-4 w-4 mr-2" />
                Download PDF
              </Button>
              <Button variant="outline" onClick={handleDownloadExcel}>
                <Download className="h-4 w-4 mr-2" />
                Download Excel
              </Button>
              <Button onClick={handlePrint} disabled={isPrinting || !pdfBlob}>
                {isPrinting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Printer className="h-4 w-4 mr-2" />
                )}
                Print
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
