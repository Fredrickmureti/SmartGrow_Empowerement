import { useState, useMemo, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { usePeekParam } from "@/design-system";
import { VendorStatementPeekSheet } from "@/features/purchases/statements/VendorStatementPeekSheet";

import { useVendorStatements, VendorStatementData } from "@/hooks/useVendorStatements";

import { useBranches } from "@/hooks/useBranches";
import { useContacts } from "@/hooks/useContacts";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrency } from "@/hooks/useCurrency";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { VendorStatementPreview } from "@/components/purchases/VendorStatementPreview";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileText,
  Loader2,
  Download,
  Send,
  Eye,
  Search,
  MoreHorizontal,
  AlertTriangle,
  Plus,
  DollarSign,
  Users as UsersIcon,
  Trash2,
} from "lucide-react";
import { format, subMonths, startOfMonth, endOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { toast } from "sonner";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { Progress } from "@/components/ui/progress";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { normalizeError } from "@/services/resilience";
import { downloadExport } from "@/services/exports";

export default function VendorStatements() {
  const [searchParams, setSearchParams] = useSearchParams();
  const autoActionRef = useRef(false);
  const [peekId, setPeekId] = usePeekParam();
  const { statements, isLoading, generateStatementData, saveStatement, deleteStatement } = useVendorStatements();
  const { contacts } = useContacts();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();

  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [periodStart, setPeriodStart] = useState(
    format(startOfMonth(subMonths(new Date(), 1)), "yyyy-MM-dd")
  );
  const [periodEnd, setPeriodEnd] = useState(
    format(endOfMonth(subMonths(new Date(), 1)), "yyyy-MM-dd")
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const { currentBranch } = useBranches();
  const [consolidate, setConsolidate] = useState(false);
  const [loadingStatementId, setLoadingStatementId] = useState<string | null>(null);
  const [selectedStatementIds, setSelectedStatementIds] = useState<Set<string>>(new Set());
  const [previewData, setPreviewData] = useState<VendorStatementData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [vendorSearch, setVendorSearch] = useState("");
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [isBulkGenerating, setIsBulkGenerating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });

  const vendors = useMemo(
    () => contacts.filter((c) => c.type === "supplier" || c.type === "both"),
    [contacts]
  );

  // Auto-open generate dialog when navigated with contact_id param
  useEffect(() => {
    const contactIdParam = searchParams.get("contact_id");
    if (contactIdParam && !autoActionRef.current && vendors.length > 0) {
      autoActionRef.current = true;
      setSelectedContactId(contactIdParam);
      setShowGenerateDialog(true);
      searchParams.delete("contact_id");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, vendors, setSearchParams]);

  const filteredVendors = useMemo(() => {
    if (!vendorSearch) return vendors;
    return vendors.filter(
      (c) =>
        c.name.toLowerCase().includes(vendorSearch.toLowerCase()) ||
        c.company?.toLowerCase().includes(vendorSearch.toLowerCase())
    );
  }, [vendors, vendorSearch]);

  const filteredStatements = useMemo(() => {
    if (!searchQuery) return statements;
    return statements.filter(
      (s) =>
        s.contacts?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.contacts?.company?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [statements, searchQuery]);

  const metrics = useMemo(() => {
    const totalOutstanding = statements.reduce((sum, s) => sum + (s.closing_balance || 0), 0);
    const thisMonth = statements.filter(
      (s) =>
        new Date(s.created_at).getMonth() === new Date().getMonth() &&
        new Date(s.created_at).getFullYear() === new Date().getFullYear()
    ).length;
    const sent = statements.filter((s) => s.sent_at).length;
    const withBalance = statements.filter((s) => s.closing_balance > 0).length;
    return { totalOutstanding, thisMonth, sent, withBalance };
  }, [statements]);

  const handleGenerate = async () => {
    if (!selectedContactId) return;
    setIsGenerating(true);
    try {
      const data = await generateStatementData({
        contact_id: selectedContactId,
        period_start: periodStart,
        period_end: periodEnd,
        consolidate,
      });
      setPreviewData(data);
      setShowGenerateDialog(false);
      setShowPreviewDialog(true);
    } catch (error: any) {
      toast.error("Failed to generate statement: " + (normalizeError(error).message || "Unknown error"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!previewData) return;
    await saveStatement.mutateAsync(previewData);
    setShowPreviewDialog(false);
    setPreviewData(null);
  };

  /**
   * Row click / "View" action opens the standard peek sheet
   * (`?peek=<id>`) via the shared design-system param, mirroring every
   * other Purchases list. The peek sheet re-generates the statement data
   * for the saved period so peek/PDF/email pipelines stay in sync.
   */
  const handleReviewStatement = (statement: (typeof statements)[0]) => {
    setPeekId(statement.id);
  };

  const handleSendStatement = async () => {
    if (!previewData) return;
    let statementId: string | undefined;
    const matchingStatement = statements.find(
      s => s.contact_id === previewData.contact.id &&
           s.period_start === previewData.periodStart &&
           s.period_end === previewData.periodEnd
    );
    if (matchingStatement) {
      statementId = matchingStatement.id;
    } else {
      try {
        const saved = await saveStatement.mutateAsync(previewData);
        statementId = (saved as any)?.id;
        if (!statementId) {
          const { data: found } = await supabase
            // SCOPE-EXEMPT: `vendor_statements` is workspace-wide (no business_id column)
            .from("vendor_statements")
            .select("id")
            .eq("contact_id", previewData.contact.id)
            .eq("period_start", previewData.periodStart)
            .eq("period_end", previewData.periodEnd)
            .eq("organization_id", currentOrg?.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          statementId = found?.id;
        }
      } catch (error: any) {
        toast.error("Failed to save statement before sending: " + (normalizeError(error).message || "Unknown error"));
        return;
      }
    }
    if (!statementId) {
      toast.error("Could not determine statement ID for emailing");
      return;
    }
    setEmailDocument({
      documentType: "vendor_statement",
      documentId: statementId,
      documentNumber: `Vendor_Statement_${format(new Date(), "yyyy-MM-dd")}`,
      recipientEmail: previewData.contact.email || "",
      recipientName: previewData.contact.name,
      total: previewData.closingBalance,
      currency: currentBusiness?.base_currency,
    });
    setShowEmailDialog(true);
  };

  const handleDownloadPdf = async (statementData?: VendorStatementData) => {
    const dataToUse = statementData || previewData;
    if (!dataToUse) return;
    setIsGenerating(true);
    try {
      let statementId: string | undefined;
      const matchingStatement = statements.find(
        s => s.contact_id === dataToUse.contact.id &&
             s.period_start === dataToUse.periodStart &&
             s.period_end === dataToUse.periodEnd
      );
      if (matchingStatement) {
        statementId = matchingStatement.id;
      } else {
        const saved = await saveStatement.mutateAsync(dataToUse);
        statementId = (saved as any)?.id;
        if (!statementId) {
          const { data: found } = await supabase
            // SCOPE-EXEMPT: `vendor_statements` is workspace-wide (no business_id column)
            .from("vendor_statements")
            .select("id")
            .eq("contact_id", dataToUse.contact.id)
            .eq("period_start", dataToUse.periodStart)
            .eq("period_end", dataToUse.periodEnd)
            .eq("organization_id", currentOrg?.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          statementId = found?.id;
        }
      }
      if (!statementId) throw new Error("Could not determine statement ID for PDF generation");

      // "Download PDF" is a DOWNLOAD disposition — render the frozen
      // snapshot to PDF bytes and hand them to the browser. Dispatching a
      // print job here is what made a download silently hit a printer.
      const res = await downloadExport({
        documentType: "vendor_statement",
        documentId: statementId,
        format: "pdf",
        filename: `vendor-statement-${dataToUse.contact.name ?? "contact"}-${dataToUse.periodStart}-${dataToUse.periodEnd}.pdf`,
      });
      if (!res.success) throw new Error(res.error ?? "Unknown error");

    } catch (error: any) {
      console.error("Statement download error:", error);
      toast.error("Failed to download statement PDF: " + (normalizeError(error).message || "Unknown error"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleBulkGenerate = async (sendEmail = false) => {
    if (isBulkGenerating) return;
    setIsBulkGenerating(true);
    try {
      let bulkQuery = supabase
        .from("bills")
        .select("vendor_id")
        .eq("organization_id", currentOrg?.id)
        .in("status", ["received", "partial", "overdue"])
        .not("vendor_id", "is", null);
      bulkQuery = bulkQuery.eq("business_id", currentBusiness!.id);
      const { data: outstandingBills } = await bulkQuery;

      if (!outstandingBills || outstandingBills.length === 0) {
        toast.info("No vendors with outstanding bills found");
        setIsBulkGenerating(false);
        return;
      }

      const uniqueVendorIds = [...new Set(outstandingBills.map(b => b.vendor_id).filter(Boolean))] as string[];
      setBulkProgress({ current: 0, total: uniqueVendorIds.length });

      let successCount = 0;
      let emailCount = 0;
      for (let i = 0; i < uniqueVendorIds.length; i++) {
        try {
          const data = await generateStatementData({
            contact_id: uniqueVendorIds[i],
            period_start: periodStart,
            period_end: periodEnd,
          });
          const saved = await saveStatement.mutateAsync(data);

          if (sendEmail && data.contact.email) {
            try {
              const stId = (saved as any)?.id;
              if (stId) {
                await supabase.functions.invoke("send-document-email", {
                  body: {
                    documentType: "vendor_statement",
                    documentId: stId,
                    to: data.contact.email,
                    subject: `Account Statement - ${format(new Date(periodStart), "MMM yyyy")} to ${format(new Date(periodEnd), "MMM yyyy")}`,
                    body: `Dear ${data.contact.name},\n\nPlease find attached the account statement for the period ${format(new Date(periodStart), "MMMM d, yyyy")} to ${format(new Date(periodEnd), "MMMM d, yyyy")}.\n\nClosing balance: ${formatCurrency(data.closingBalance)}\n\nBest regards`,
                  },
                });
                emailCount++;
              }
            } catch (emailErr) {
              console.error(`Email failed for ${data.contact.name}:`, emailErr);
            }
          }
          successCount++;
        } catch (err) {
          console.error(`Failed for vendor ${uniqueVendorIds[i]}:`, err);
        }
        setBulkProgress({ current: i + 1, total: uniqueVendorIds.length });
      }

      toast.success(sendEmail
        ? `Generated ${successCount} statements, emailed ${emailCount}`
        : `Generated ${successCount} of ${uniqueVendorIds.length} statements`
      );
    } catch (error: any) {
      toast.error("Bulk generation failed: " + (normalizeError(error).message || "Unknown error"));
    } finally {
      setIsBulkGenerating(false);
      setBulkProgress({ current: 0, total: 0 });
    }
  };

  return (
    <>
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Vendor Statements</h1>
          <p className="text-muted-foreground text-sm sm:text-base">
            Generate and send account statements to vendors/suppliers
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <RefreshButton
            queryKeyPrefixes={[['bills'] as const, ['bill_payments'] as const]}
            tooltip="Refresh statements"
          />
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            reportSubtype="vendor_statement"
            getExportConfig={() => {
              const cols: ExportColumn[] = [
                { key: "vendor", header: "Vendor", width: 22 },
                { key: "period", header: "Period", width: 20 },
                { key: "opening", header: "Opening Balance", format: "currency", width: 14, align: "right" },
                { key: "closing", header: "Closing Balance", format: "currency", width: 14, align: "right" },
                { key: "generated", header: "Generated", width: 14 },
                { key: "sent", header: "Sent", width: 10 },
              ];
              const rows = filteredStatements.map((s) => ({
                vendor: s.contacts?.name || "",
                period: `${format(new Date(s.period_start), "MMM d, yyyy")} — ${format(new Date(s.period_end), "MMM d, yyyy")}`,
                opening: s.opening_balance || 0,
                closing: s.closing_balance || 0,
                generated: format(new Date(s.created_at), "MMM d, yyyy"),
                sent: s.sent_at ? "Yes" : "No",
              }));
              return { title: "Vendor Statements Summary", columns: cols, rows } as ExportConfig;
            }}
          />
          <Button
            variant="outline"
            onClick={() => handleBulkGenerate(false)}
            disabled={isBulkGenerating}
            className="w-full sm:w-auto"
          >
            {isBulkGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UsersIcon className="mr-2 h-4 w-4" />}
            Generate All
          </Button>
          <Button
            variant="outline"
            onClick={() => handleBulkGenerate(true)}
            disabled={isBulkGenerating}
            className="w-full sm:w-auto"
          >
            {isBulkGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Generate & Email All
          </Button>
          <Button
            onClick={() => {
              if (isReadOnly) { openUpgradeModal("vendor_statements"); return; }
              setVendorSearch("");
              setSelectedContactId("");
              setShowGenerateDialog(true);
            }}
            className="w-full sm:w-auto shrink-0"
          >
            <Plus className="mr-2 h-4 w-4" />
            Generate Statement
          </Button>
        </div>
      </div>

      {/* Bulk progress */}
      {isBulkGenerating && bulkProgress.total > 0 && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <div className="flex-1">
                <p className="text-sm font-medium">
                  Generating statements... {bulkProgress.current} of {bulkProgress.total}
                </p>
                <Progress value={(bulkProgress.current / bulkProgress.total) * 100} className="mt-2" />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="stats-grid grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />Total Statements</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{statements.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1.5"><DollarSign className="h-3.5 w-3.5" />Total Outstanding</CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{formatCurrency(metrics.totalOutstanding)}</div>
            <p className="text-xs text-muted-foreground mt-1">Across all statements</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1.5"><Send className="h-3.5 w-3.5" />Sent</CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{metrics.sent}</div>
            <p className="text-xs text-muted-foreground mt-1">of {statements.length} total</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" />With Balance</CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{metrics.withBalance}</div>
            <p className="text-xs text-muted-foreground mt-1">Outstanding</p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search statements by vendor name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 w-full"
          />
        </div>
      </div>

      {/* Statement History */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Statement History</CardTitle>
            <CardDescription>Previously generated vendor statements — click to re-view</CardDescription>
          </div>
          {selectedStatementIds.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{selectedStatementIds.size} selected</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Delete ${selectedStatementIds.size} statement(s)?`)) {
                    Promise.all(Array.from(selectedStatementIds).map(id => deleteStatement.mutateAsync(id)))
                      .then(() => setSelectedStatementIds(new Set()));
                  }
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />Delete Selected
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredStatements.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">{searchQuery ? "No matching statements" : "No statements generated"}</h3>
              <p className="text-muted-foreground mb-4">{searchQuery ? "Try adjusting your search" : "Generate your first vendor statement"}</p>
            </div>
          ) : (
            <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="rounded border-border"
                        checked={filteredStatements.length > 0 && selectedStatementIds.size === filteredStatements.length}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedStatementIds(new Set(filteredStatements.map(s => s.id)));
                          else setSelectedStatementIds(new Set());
                        }}
                      />
                    </TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Opening</TableHead>
                    <TableHead className="text-right">Billed</TableHead>
                    <TableHead className="text-right">Payments</TableHead>
                    <TableHead className="text-right">Closing</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Generated</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStatements.map((statement) => (
                    <TableRow
                      key={statement.id}
                      className={`cursor-pointer transition-colors ${
                        loadingStatementId === statement.id ? "bg-muted/50 pointer-events-none" :
                        isGenerating ? "pointer-events-none opacity-60" : "hover:bg-muted/30"
                      }`}
                      onClick={() => handleReviewStatement(statement)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="rounded border-border"
                          checked={selectedStatementIds.has(statement.id)}
                          onChange={(e) => {
                            const next = new Set(selectedStatementIds);
                            if (e.target.checked) next.add(statement.id); else next.delete(statement.id);
                            setSelectedStatementIds(next);
                          }}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {loadingStatementId === statement.id && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
                          <div>
                            <p onClick={(e) => e.stopPropagation()}>
                              {statement.contact_id ? (
                                <ClickableEntity onClick={() => { setContactDrawerId(statement.contact_id); setContactDrawerOpen(true); }}>
                                  {statement.contacts?.name}
                                </ClickableEntity>
                              ) : statement.contacts?.name}
                            </p>
                            {statement.contacts?.company && <p className="text-xs text-muted-foreground">{statement.contacts.company}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(statement.period_start), "MMM d")} – {format(new Date(statement.period_end), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-right">{formatCurrency(statement.opening_balance)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(statement.total_billed)}</TableCell>
                      <TableCell className="text-right text-green-600">{formatCurrency(statement.total_payments)}</TableCell>
                      <TableCell className="text-right font-medium">
                        <span className={statement.closing_balance > 0 ? "text-destructive" : ""}>{formatCurrency(statement.closing_balance)}</span>
                      </TableCell>
                      <TableCell>
                        {statement.sent_at ? (
                          <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">Sent</Badge>
                        ) : (
                          <Badge variant="outline">Draft</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{format(new Date(statement.created_at), "MMM d, yyyy")}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleReviewStatement(statement)}>
                              <Eye className="mr-2 h-4 w-4" />View Statement
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={async () => {
                              try {
                                const data = await generateStatementData({ contact_id: statement.contact_id, period_start: statement.period_start, period_end: statement.period_end });
                                await handleDownloadPdf(data);
                              } catch (err: any) { toast.error("Failed to download: " + normalizeError(err).message); }
                            }}>
                              <Download className="mr-2 h-4 w-4" />Download PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={async () => {
                              const res = await downloadExport({
                                documentType: "vendor_statement",
                                documentId: statement.id,
                                format: "csv",
                                filename: `vendor-statement-${format(new Date(statement.statement_date), "yyyy-MM-dd")}-${statement.contacts?.name ?? "vendor"}.csv`,
                              });
                              if (!res.success) toast.error("Export failed: " + (res.error ?? "Unknown error"));
                              else toast.success("CSV export archived to version history");
                            }}>
                              <Download className="mr-2 h-4 w-4" />Export CSV
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={async () => {
                              try {
                                setEmailDocument({
                                  documentType: "vendor_statement",
                                  documentId: statement.id,
                                  documentNumber: `Vendor_Statement_${format(new Date(statement.statement_date), "yyyy-MM-dd")}`,
                                  recipientEmail: statement.contacts?.email || "",
                                  recipientName: statement.contacts?.name || "",
                                  total: statement.closing_balance,
                                  currency: currentBusiness?.base_currency,
                                });
                                setShowEmailDialog(true);
                              } catch (err: any) { toast.error("Failed: " + normalizeError(err).message); }
                            }}>
                              <Send className="mr-2 h-4 w-4" />Send Email
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => {
                                if (window.confirm(`Delete statement for ${statement.contacts?.name || "this vendor"}?`)) {
                                  deleteStatement.mutate(statement.id);
                                }
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Generate Dialog */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Vendor Statement</DialogTitle>
            <DialogDescription>Select a vendor and date range to generate their AP statement</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor *</Label>
              <div className="space-y-2">
                <Input placeholder="Search vendors..." value={vendorSearch} onChange={(e) => setVendorSearch(e.target.value)} className="mb-1" />
                <Select value={selectedContactId} onValueChange={setSelectedContactId}>
                  <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                  <SelectContent>
                    {filteredVendors.length === 0 ? (
                      <div className="py-2 px-3 text-sm text-muted-foreground">No vendors found</div>
                    ) : (
                      filteredVendors.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name} {c.company && `(${c.company})`}</SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Period Start</Label>
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Period End</Label>
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => { setPeriodStart(format(startOfMonth(subMonths(new Date(), 1)), "yyyy-MM-dd")); setPeriodEnd(format(endOfMonth(subMonths(new Date(), 1)), "yyyy-MM-dd")); }}>Last Month</Button>
              <Button variant="outline" size="sm" onClick={() => { setPeriodStart(format(startOfMonth(subMonths(new Date(), 3)), "yyyy-MM-dd")); setPeriodEnd(format(endOfMonth(new Date()), "yyyy-MM-dd")); }}>Last 3 Months</Button>
              <Button variant="outline" size="sm" onClick={() => { setPeriodStart(format(new Date(new Date().getFullYear(), 0, 1), "yyyy-MM-dd")); setPeriodEnd(format(new Date(), "yyyy-MM-dd")); }}>Year to Date</Button>
            </div>

            {/* Phase F: Consolidate parent + children (Odoo-grade) */}
            {(() => {
              const sel = vendors.find((c) => c.id === selectedContactId) as any;
              const hasFamily =
                sel &&
                (sel.is_company ||
                  vendors.some((c: any) => c.parent_contact_id === selectedContactId));
              if (!hasFamily) return null;
              return (
                <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
                  <input
                    id="vendor-consolidate-toggle"
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={consolidate}
                    onChange={(e) => setConsolidate(e.target.checked)}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="vendor-consolidate-toggle" className="cursor-pointer">
                      Consolidate parent + child contacts
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Aggregate transactions across the entire commercial partner family.
                    </p>
                  </div>
                </div>
              );
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={!selectedContactId || isGenerating}>
              {isGenerating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={showPreviewDialog} onOpenChange={setShowPreviewDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Vendor Statement Preview</DialogTitle>
            <DialogDescription>Review the statement before saving or sending</DialogDescription>
          </DialogHeader>
          {previewData && <VendorStatementPreview data={previewData} />}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setShowPreviewDialog(false); setPreviewData(null); }}>Close</Button>
            <Button variant="outline" onClick={() => handleDownloadPdf()} disabled={isGenerating}>
              {isGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Download PDF
            </Button>
            <Button variant="outline" onClick={handleSendStatement}>
              <Send className="mr-2 h-4 w-4" />Send
            </Button>
            <Button onClick={handleSave} disabled={saveStatement.isPending}>
              {saveStatement.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Statement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Dialog */}
      {showEmailDialog && emailDocument && (
        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
        />
      )}
    </div>

    {/* Contact Drawer */}
    <ContactPreviewDrawer
      contactId={contactDrawerId}
      open={contactDrawerOpen}
      onOpenChange={setContactDrawerOpen}
    />

    {/* Standard peek surface — retires the inline preview dialog for
        the VIEW path. The Generate flow keeps its own preview because
        it operates on unsaved computed data. */}
    <VendorStatementPeekSheet
      statementId={peekId}
      onOpenChange={(o) => !o && setPeekId(null)}
    />
    </>
  );
}
