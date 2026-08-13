/**
 * Report Export Buttons Component
 * 
 * Standard toolbar for exporting reports in various formats.
 * Includes print preview, direct print, and PDF download.
 * Mobile-optimized: shows "Download PDF" as primary action on small screens.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, FileSpreadsheet, FileText, Printer, Eye, ChevronDown, FileDown, Loader2, Mail } from "lucide-react";
import {
  exportToCSV,
  exportToExcel,
  printReportAsPdf,
  exportToPDF,
  type ExportConfig,
} from "@/services/reports/ReportExportService";
import { ReportPreviewDialog } from "./ReportPreviewDialog";
import { EmailReportDialog } from "./EmailReportDialog";
import { useReportExportContext } from "@/contexts/ReportContext";
import { toast } from "sonner";

interface ReportExportButtonsProps {
  /**
   * May be async: server-paginated reports fetch the FULL dataset at export
   * time rather than exporting whatever page is on screen.
   */
  getExportConfig: () => ExportConfig | Promise<ExportConfig>;
  formats?: ("excel" | "csv" | "print" | "pdf")[];
  compact?: boolean;
  /** Pre-fill the To: field of the Email Report dialog (e.g. selected vendor email). */
  defaultRecipientEmail?: string | null;
  /** Hint stored in the email audit row, e.g. "vendor_statement". */
  reportSubtype?: string;
  /**
   * Hide the "Email Report…" action. Set on employee self-service surfaces
   * (`/me/*`) — sending PII reports to arbitrary recipients is an admin-only
   * capability per enterprise self-service norms (Workday/BambooHR/Odoo).
   */
  hideEmail?: boolean;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

export function ReportExportButtons({
  getExportConfig,
  formats = ["excel", "csv", "print", "pdf"],
  compact = false,
  defaultRecipientEmail,
  reportSubtype,
  hideEmail = false,
}: ReportExportButtonsProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const isMobile = useIsMobile();
  const { enrichExportConfig } = useReportExportContext();

  /** Single funnel — every export call enriches with org/branding context. */
  const buildConfig = async (): Promise<ExportConfig> => {
    const raw = await getExportConfig();
    const enriched = enrichExportConfig(raw);
    enriched.generatedAt = new Date();
    return enriched;
  };

  const handleExport = async (format: "excel" | "csv") => {
    setIsExporting(true);
    try {
      const config = buildConfig();

      switch (format) {
        case "excel":
          await exportToExcel(config);
          toast.success("Excel file exported successfully");
          break;
        case "csv":
          await exportToCSV(config);
          toast.success("CSV file exported successfully");
          break;
      }
    } catch (error) {
      console.error("Export error:", error);
      toast.error("Failed to export report. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  const handlePrintReport = async () => {
    setIsGeneratingPDF(true);
    try {
      const config = buildConfig();
      await printReportAsPdf(config);
      toast.success("Report opened for printing");
    } catch (error) {
      console.error("Print error:", error);
      toast.error("Failed to generate print PDF. Please try again.");
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  const handleDownloadPDF = async () => {
    setIsGeneratingPDF(true);
    try {
      const config = buildConfig();
      await exportToPDF(config);
      toast.success("PDF downloaded successfully");
    } catch (error) {
      console.error("PDF generation error:", error);
      toast.error("Failed to generate PDF. Please try again.");
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Mobile: show Download PDF as primary action */}
        {isMobile && formats.includes("pdf") && (
          <Button
            variant="default"
            size={compact ? "icon" : "default"}
            onClick={handleDownloadPDF}
            disabled={isGeneratingPDF}
            className="gap-2"
          >
            {isGeneratingPDF ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            {!compact && (isGeneratingPDF ? "Generating…" : "Download PDF")}
          </Button>
        )}

        {/* Desktop: Print Preview Button */}
        {!isMobile && formats.includes("print") && (
          <Button
            variant="outline"
            size={compact ? "icon" : "default"}
            onClick={() => setShowPreview(true)}
            className="gap-2"
          >
            <Eye className="h-4 w-4" />
            {!compact && "Preview"}
          </Button>
        )}

        {/* Export Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={isExporting || isGeneratingPDF} className="gap-2">
              <Download className="h-4 w-4" />
              {!compact && "Export"}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* PDF option (shown in dropdown on desktop, hidden on mobile since it's primary) */}
            {!isMobile && formats.includes("pdf") && (
              <DropdownMenuItem onClick={handleDownloadPDF} disabled={isGeneratingPDF}>
                <FileDown className="h-4 w-4 mr-2" />
                {isGeneratingPDF ? "Generating PDF…" : "Download as PDF"}
              </DropdownMenuItem>
            )}
            {formats.includes("excel") && (
              <DropdownMenuItem onClick={() => handleExport("excel")}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Export as Excel (.xlsx)
              </DropdownMenuItem>
            )}
            {formats.includes("csv") && (
              <DropdownMenuItem onClick={() => handleExport("csv")}>
                <FileText className="h-4 w-4 mr-2" />
                Export as CSV
              </DropdownMenuItem>
            )}
            {!isMobile && formats.includes("print") && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setShowPreview(true)}>
                  <Eye className="h-4 w-4 mr-2" />
                  Print Preview
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handlePrintReport} disabled={isGeneratingPDF}>
                  <Printer className="h-4 w-4 mr-2" />
                  {isGeneratingPDF ? "Generating PDF…" : "Print as PDF"}
                </DropdownMenuItem>
                {!hideEmail && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setShowEmailDialog(true)}>
                      <Mail className="h-4 w-4 mr-2" />
                      Email Report…
                    </DropdownMenuItem>
                  </>
                )}
              </>
            )}
            {/* Email is also valuable on mobile / when print isn't shown */}
            {!hideEmail && (isMobile || !formats.includes("print")) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setShowEmailDialog(true)}>
                  <Mail className="h-4 w-4 mr-2" />
                  Email Report…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Print Preview Dialog — desktop only */}
      {!isMobile && (
        <ReportPreviewDialog
          open={showPreview}
          onOpenChange={setShowPreview}
          getExportConfig={() => enrichExportConfig(getExportConfig())}
        />
      )}

      {/* Email Report Dialog — never mounted on portal surfaces */}
      {!hideEmail && (
        <EmailReportDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          buildConfig={buildConfig}
          defaultRecipientEmail={defaultRecipientEmail}
          reportSubtype={reportSubtype}
        />
      )}
    </>
  );
}
