import { useState, useMemo, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { useCustomerStatements, CustomerStatementData } from "@/hooks/useCustomerStatements";
import { useContacts } from "@/hooks/useContacts";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrency } from "@/hooks/useCurrency";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { StatementPreview } from "@/components/sales/StatementPreview";
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
  Calendar,
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
import { fetchReceivableCounterparties } from "@/services/finance/openItems";

export default function CustomerStatements() {
  const [searchParams, setSearchParams] = useSearchParams();
  const autoActionRef = useRef(false);
  const { statements, isLoading, generateStatementData, saveStatement, deleteStatement } = useCustomerStatements();
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
  const [consolidate, setConsolidate] = useState(false);
  const [loadingStatementId, setLoadingStatementId] = useState<string | null>(null);
  const [selectedStatementIds, setSelectedStatementIds] = useState<Set<string>>(new Set());
  const [previewData, setPreviewData] = useState<CustomerStatementData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [isBulkGenerating, setIsBulkGenerating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });

  const customers = useMemo(
    () => contacts.filter((c) => c.type === "customer" || c.type === "both"),
    [contacts]
  );

  // Auto-open generate dialog when navigated with contact_id param
  useEffect(() => {
    const contactIdParam = searchParams.get("contact_id");
    if (contactIdParam && !autoActionRef.current && customers.length > 0) {
      autoActionRef.current = true;
      setSelectedContactId(contactIdParam);
      setShowGenerateDialog(true);
      searchParams.delete("contact_id");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, customers, setSearchParams]);


  const filteredCustomers = useMemo(() => {
    if (!customerSearch) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
        c.company?.toLowerCase().includes(customerSearch.toLowerCase())
    );
  }, [customers, customerSearch]);

  const filteredStatements = useMemo(() => {
    if (!searchQuery) return statements;
    return statements.filter(
      (s) =>
        s.contacts?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.contacts?.company?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [statements, searchQuery]);

  // Dashboard metrics
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

  const handleReviewStatement = async (statement: (typeof statements)[0]) => {
    if (isGenerating) return; // Prevent double-clicks
    setIsGenerating(true);
    setLoadingStatementId(statement.id);
    try {
      const data = await generateStatementData({
        contact_id: statement.contact_id,
        period_start: statement.period_start,
        period_end: statement.period_end,
      });
      setPreviewData(data);
      setShowPreviewDialog(true);
    } catch (error: any) {
      toast.error("Failed to load statement: " + (normalizeError(error).message || "Unknown error"));
    } finally {
      setIsGenerating(false);
      setLoadingStatementId(null);
    }
  };

  const handleSendStatement = async () => {
    if (!previewData) return;

    // Resolve a saved statement ID (same pattern as handlePrint)
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
          const { supabase } = await import("@/integrations/supabase/client");
          const { data: found } = await supabase
            .from("customer_statements")
            .select("id")
            .eq("contact_id", previewData.contact.id)
            .eq("period_start", previewData.periodStart)
            .eq("period_end", previewData.periodEnd)
            .eq("organization_id", currentOrg?.id)
            .eq("business_id", currentBusiness.id)
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
      documentType: "customer_statement",
      documentId: statementId,
      documentNumber: `Statement_${format(new Date(), "yyyy-MM-dd")}`,
      recipientEmail: previewData.contact.email || "",
      recipientName: previewData.contact.name,
      total: previewData.closingBalance,
      // Currency comes from the statement's owning business — never the org.
      currency: currentBusiness?.base_currency ?? undefined,
    });
    setShowEmailDialog(true);
  };

  const handleDownloadPdf = async (statementData?: CustomerStatementData) => {
    const dataToUse = statementData || previewData;
    if (!dataToUse) return;

    // We need the saved statement ID to use the unified engine.
    // If not yet saved, save first, then download.
    setIsGenerating(true);
    try {
      let statementId: string | undefined;

      // Check if this statement is already saved by looking it up
      const matchingStatement = statements.find(
        s => s.contact_id === dataToUse.contact.id &&
             s.period_start === dataToUse.periodStart &&
             s.period_end === dataToUse.periodEnd
      );

      if (matchingStatement) {
        statementId = matchingStatement.id;
      } else {
        // Save first to get an ID
        const saved = await saveStatement.mutateAsync(dataToUse);
        statementId = (saved as any)?.id;
        // If the mutation doesn't return the ID, try finding it again
        if (!statementId) {
          const { supabase } = await import("@/integrations/supabase/client");
          const { data: found } = await supabase
            .from("customer_statements")
            .select("id")
            .eq("contact_id", dataToUse.contact.id)
            .eq("period_start", dataToUse.periodStart)
            .eq("period_end", dataToUse.periodEnd)
            .eq("organization_id", currentOrg?.id)
            .eq("business_id", currentBusiness.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          statementId = found?.id;
        }
      }

      if (!statementId) {
        throw new Error("Could not determine statement ID for PDF generation");
      }

      // "Download PDF" is a DOWNLOAD disposition. It renders the frozen
      // snapshot to PDF bytes and hands them to the browser — it must never
      // dispatch a print job to a physical printer. Printing is a separate,
      // explicit action.
      const res = await downloadExport({
        documentType: "customer_statement",
        documentId: statementId,
        format: "pdf",
        filename: `customer-statement-${dataToUse.contact.name ?? "contact"}-${dataToUse.periodStart}-${dataToUse.periodEnd}.pdf`,
      });
      if (!res.success) throw new Error(res.error ?? "Unknown error");
    } catch (error: any) {
      console.error("Statement download error:", error);
      toast.error("Failed to download statement PDF: " + (normalizeError(error).message || "Unknown error"));
    } finally {
      setIsGenerating(false);
    }
  };

  // Bulk generation handler
  //
  // Cohort: `fetchReceivableCounterparties` (canonical `finance_ar_net_position`).
  // Never `invoices.status` — that both invents debt for unposted documents and
  // hides receivables that originate from manual journals on AR control.
  //
  // Delivery: statements are enqueued into `customer_statement_send_jobs` and
  // drained by the scheduled worker. The browser never sends the emails, so
  // closing the tab cannot truncate a run, every attempt is retried with
  // backoff, and the per-(statement, recipient) idempotency key makes a re-run
  // a no-op instead of a second email.
  const handleBulkGenerate = async (sendEmail = false) => {
    if (isBulkGenerating) return;
    // Statements summarize a Company's books — refuse to bulk-generate
    // without a business_id (would cross legal-entity boundaries).
    if (!currentBusiness?.id) {
      toast.error("Select a Company first to generate statements.");
      return;
    }
    if (!currentOrg?.id) return;
    setIsBulkGenerating(true);

    try {
      const cohort = await fetchReceivableCounterparties(
        currentOrg.id,
        currentBusiness.id,
      );

      if (cohort.length === 0) {
        toast.info("No customers with outstanding balances found");
        setIsBulkGenerating(false);
        return;
      }

      setBulkProgress({ current: 0, total: cohort.length });

      let successCount = 0;
      let queuedCount = 0;
      let skippedNoEmail = 0;
      for (let i = 0; i < cohort.length; i++) {
        const target = cohort[i];
        try {
          const data = await generateStatementData({
            contact_id: target.contactId,
            period_start: periodStart,
            period_end: periodEnd,
          });
          const saved = await saveStatement.mutateAsync(data);
          successCount++;

          if (sendEmail) {
            const statementId = (saved as any)?.id;
            if (!data.contact.email) {
              skippedNoEmail++;
            } else if (statementId) {
              const { error: queueError } = await supabase.rpc(
                "enqueue_customer_statement_send" as any,
                {
                  _statement_id: statementId,
                  _recipient_email: data.contact.email,
                  _subject: `Account Statement - ${format(new Date(periodStart), "MMM yyyy")} to ${format(new Date(periodEnd), "MMM yyyy")}`,
                  _message: `Dear ${data.contact.name},\n\nPlease find attached your account statement for the period ${format(new Date(periodStart), "MMMM d, yyyy")} to ${format(new Date(periodEnd), "MMMM d, yyyy")}.\n\nClosing balance: ${formatCurrency(data.closingBalance)}\n\nPlease do not hesitate to contact us if you have any questions.\n\nBest regards`,
                } as any,
              );
              if (queueError) throw queueError;
              queuedCount++;
            }
          }
        } catch (err) {
          console.error(`Failed for contact ${target.contactId}:`, err);
        }
        setBulkProgress({ current: i + 1, total: cohort.length });
      }

      if (sendEmail) {
        toast.success(
          `Generated ${successCount} statements, queued ${queuedCount} for delivery` +
            (skippedNoEmail > 0 ? ` (${skippedNoEmail} without an email address)` : ""),
        );
      } else {
        toast.success(`Generated ${successCount} of ${cohort.length} statements`);
      }
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
          <h1 className="page-title">Customer Statements</h1>
          <p className="text-muted-foreground text-sm sm:text-base">
            Generate and send account statements to customers
          </p>
          <div className="mt-2"><FinanceScopeBadge /></div>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <RefreshButton
            queryKeyPrefixes={[
              ['invoices'] as const,
              ['payments'] as const,
            ]}
            tooltip="Refresh statements"
          />
          <ReportExportButtons
            compact
            formats={["excel", "csv", "pdf"]}
            getExportConfig={() => {
              const cols: ExportColumn[] = [
                { key: "customer", header: "Customer", width: 22 },
                { key: "period", header: "Period", width: 20 },
                { key: "opening", header: "Opening Balance", format: "currency", width: 14, align: "right" },
                { key: "closing", header: "Closing Balance", format: "currency", width: 14, align: "right" },
                { key: "generated", header: "Generated", width: 14 },
                { key: "sent", header: "Sent", width: 10 },
              ];
              const rows = filteredStatements.map((s) => ({
                customer: s.contacts?.name || "",
                period: `${format(new Date(s.period_start), "MMM d, yyyy")} — ${format(new Date(s.period_end), "MMM d, yyyy")}`,
                opening: s.opening_balance || 0,
                closing: s.closing_balance || 0,
                generated: format(new Date(s.created_at), "MMM d, yyyy"),
                sent: s.sent_at ? "Yes" : "No",
              }));
              return {
                title: "Customer Statements Summary",
                columns: cols,
                rows,
              } as ExportConfig;
            }}
          />
          <Button
            variant="outline"
            onClick={() => handleBulkGenerate(false)}
            disabled={isBulkGenerating}
            className="w-full sm:w-auto"
          >
            {isBulkGenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <UsersIcon className="mr-2 h-4 w-4" />
            )}
            Generate All
          </Button>
          <Button
            variant="outline"
            onClick={() => handleBulkGenerate(true)}
            disabled={isBulkGenerating}
            className="w-full sm:w-auto"
          >
            {isBulkGenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Generate & Email All
          </Button>
          <Button onClick={() => {
              if (isReadOnly) {
                openUpgradeModal("customer_statements");
                return;
              }
              setCustomerSearch("");
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

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Total Statements
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statements.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" />
                Total Outstanding
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{formatCurrency(metrics.totalOutstanding)}</div>
              <p className="text-xs text-muted-foreground mt-1">Across all statements</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Send className="h-3.5 w-3.5" />
                Sent
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{metrics.sent}</div>
              <p className="text-xs text-muted-foreground mt-1">of {statements.length} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                With Balance
              </CardDescription>
            </CardHeader>
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
              placeholder="Search statements by customer name..."
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
              <CardDescription>Previously generated customer statements — click to re-view</CardDescription>
            </div>
            {selectedStatementIds.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {selectedStatementIds.size} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Delete ${selectedStatementIds.size} statement(s)?`)) {
                      Promise.all(
                        Array.from(selectedStatementIds).map((id) =>
                          deleteStatement.mutateAsync(id)
                        )
                      ).then(() => {
                        setSelectedStatementIds(new Set());
                      });
                    }
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Selected
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
                <h3 className="text-lg font-medium">
                  {searchQuery ? "No matching statements" : "No statements generated"}
                </h3>
                <p className="text-muted-foreground mb-4">
                  {searchQuery ? "Try adjusting your search" : "Generate your first customer statement"}
                </p>
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
                             if (e.target.checked) {
                               setSelectedStatementIds(new Set(filteredStatements.map((s) => s.id)));
                             } else {
                               setSelectedStatementIds(new Set());
                             }
                           }}
                         />
                       </TableHead>
                       <TableHead>Customer</TableHead>
                       <TableHead>Period</TableHead>
                       <TableHead className="text-right">Opening</TableHead>
                       <TableHead className="text-right">Invoiced</TableHead>
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
                          loadingStatementId === statement.id
                            ? "bg-muted/50 pointer-events-none"
                            : isGenerating
                              ? "pointer-events-none opacity-60"
                              : "hover:bg-muted/30"
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
                              if (e.target.checked) {
                                next.add(statement.id);
                              } else {
                                next.delete(statement.id);
                              }
                              setSelectedStatementIds(next);
                            }}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {loadingStatementId === statement.id && (
                              <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                            )}
                            <div>
                              <p onClick={(e) => e.stopPropagation()}>
                                {statement.contact_id ? (
                                  <ClickableEntity onClick={() => { setContactDrawerId(statement.contact_id); setContactDrawerOpen(true); }}>
                                    {statement.contacts?.name}
                                  </ClickableEntity>
                                ) : statement.contacts?.name}
                              </p>
                              {statement.contacts?.company && (
                                <p className="text-xs text-muted-foreground">{statement.contacts.company}</p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(statement.period_start), "MMM d")} –{" "}
                          {format(new Date(statement.period_end), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(statement.opening_balance)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(statement.total_invoiced)}</TableCell>
                        <TableCell className="text-right text-green-600">
                          {formatCurrency(statement.total_payments)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          <span className={statement.closing_balance > 0 ? "text-destructive" : ""}>
                            {formatCurrency(statement.closing_balance)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {statement.sent_at ? (
                            <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                              Sent
                            </Badge>
                          ) : (
                            <Badge variant="outline">Draft</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(statement.created_at), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleReviewStatement(statement)}>
                                <Eye className="mr-2 h-4 w-4" />
                                View Statement
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={async () => {
                                  // Download is a DOWNLOAD disposition: render the
                                  // frozen snapshot to PDF bytes and hand them to the
                                  // browser. It must never dispatch a print job.
                                  const res = await downloadExport({
                                    documentType: "customer_statement",
                                    documentId: statement.id,
                                    format: "pdf",
                                    filename: `customer-statement-${format(new Date(statement.statement_date), "yyyy-MM-dd")}-${statement.contacts?.name ?? "contact"}.pdf`,
                                  });
                                  if (!res.success) {
                                    toast.error("Failed to download: " + (res.error ?? "Unknown error"));
                                  }
                                }}
                              >
                                <Download className="mr-2 h-4 w-4" />
                                Download PDF
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={async () => {
                                  const res = await downloadExport({
                                    documentType: "customer_statement",
                                    documentId: statement.id,
                                    format: "csv",
                                    filename: `customer-statement-${format(new Date(statement.statement_date), "yyyy-MM-dd")}-${statement.contacts?.name ?? "contact"}.csv`,
                                  });
                                  if (!res.success) {
                                    toast.error("Export failed: " + (res.error ?? "Unknown error"));
                                  } else {
                                    toast.success("CSV export archived to version history");
                                  }
                                }}
                              >
                                <Download className="mr-2 h-4 w-4" />
                                Export CSV
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={async () => {
                                  try {
                                    const data = await generateStatementData({
                                      contact_id: statement.contact_id,
                                      period_start: statement.period_start,
                                      period_end: statement.period_end,
                                    });
                                    setEmailDocument({
                                      documentType: "customer_statement",
                                      documentId: statement.id,
                                      documentNumber: `Statement_${format(new Date(statement.statement_date), "yyyy-MM-dd")}`,
                                      recipientEmail: statement.contacts?.email || "",
                                      recipientName: statement.contacts?.name || "",
                                      total: statement.closing_balance,
                                      // Currency from business (legal entity), not org tenant.
                                      currency: currentBusiness?.base_currency ?? undefined,
                                    });
                                    setShowEmailDialog(true);
                                  } catch (err: any) {
                                    toast.error("Failed: " + normalizeError(err).message);
                                  }
                                }}
                              >
                                <Send className="mr-2 h-4 w-4" />
                                Send Email
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => {
                                  if (window.confirm(`Delete statement for ${statement.contacts?.name || "this contact"}?`)) {
                                    deleteStatement.mutate(statement.id);
                                  }
                                }}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
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

        {/* Generate Statement Dialog */}
        <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Generate Customer Statement</DialogTitle>
              <DialogDescription>
                Select a customer and date range to generate their account statement
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Customer *</Label>
                <div className="space-y-2">
                  <Input
                    placeholder="Search customers..."
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    className="mb-1"
                  />
                  <Select value={selectedContactId} onValueChange={setSelectedContactId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredCustomers.length === 0 ? (
                        <div className="py-2 px-3 text-sm text-muted-foreground">No customers found</div>
                      ) : (
                        filteredCustomers.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name} {c.company && `(${c.company})`}
                          </SelectItem>
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

              {/* Quick period selectors */}
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const now = new Date();
                    setPeriodStart(format(startOfMonth(now), "yyyy-MM-dd"));
                    setPeriodEnd(format(endOfMonth(now), "yyyy-MM-dd"));
                  }}
                >
                  This Month
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const lm = subMonths(new Date(), 1);
                    setPeriodStart(format(startOfMonth(lm), "yyyy-MM-dd"));
                    setPeriodEnd(format(endOfMonth(lm), "yyyy-MM-dd"));
                  }}
                >
                  Last Month
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const now = new Date();
                    setPeriodStart(format(startOfMonth(subMonths(now, 3)), "yyyy-MM-dd"));
                    setPeriodEnd(format(endOfMonth(now), "yyyy-MM-dd"));
                  }}
                >
                  Last 3 Months
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const now = new Date();
                    setPeriodStart(format(new Date(now.getFullYear(), 0, 1), "yyyy-MM-dd"));
                    setPeriodEnd(format(now, "yyyy-MM-dd"));
                  }}
                >
                  Year to Date
                </Button>
              </div>

              {/* Phase F: Consolidate parent + children (Odoo-grade) */}
              {(() => {
                const sel = customers.find((c) => c.id === selectedContactId) as any;
                const hasFamily =
                  sel &&
                  (sel.is_company ||
                    customers.some((c: any) => c.parent_contact_id === selectedContactId));
                if (!hasFamily) return null;
                return (
                  <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
                    <input
                      id="consolidate-toggle"
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={consolidate}
                      onChange={(e) => setConsolidate(e.target.checked)}
                    />
                    <div className="space-y-1">
                      <Label htmlFor="consolidate-toggle" className="cursor-pointer">
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
              <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>
                Cancel
              </Button>
              <Button onClick={handleGenerate} disabled={isGenerating || !selectedContactId}>
                {isGenerating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Preview Statement Dialog — Professional Layout */}
        <Dialog open={showPreviewDialog} onOpenChange={setShowPreviewDialog}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto p-0">
            <div className="sticky top-0 z-10 bg-background border-b px-4 sm:px-6 py-3 sm:py-4 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:justify-between">
              <div>
                <DialogTitle className="text-base sm:text-lg">Statement Preview</DialogTitle>
                <DialogDescription className="text-xs sm:text-sm">
                  Review, save, download, or send this statement
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="flex-1 sm:flex-none text-xs sm:text-sm" onClick={() => handleDownloadPdf()} disabled={isGenerating}>
                  {isGenerating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
                  PDF
                </Button>
                <Button variant="outline" size="sm" className="flex-1 sm:flex-none text-xs sm:text-sm" onClick={handleSendStatement}>
                  <Send className="mr-1 h-3.5 w-3.5" />
                  Send
                </Button>
                <Button size="sm" className="flex-1 sm:flex-none text-xs sm:text-sm" onClick={handleSave}>
                  Save
                </Button>
              </div>
            </div>

            <div className="p-3 sm:p-6 overflow-x-auto">
              {previewData && <StatementPreview data={previewData} />}
            </div>
          </DialogContent>
        </Dialog>

        {/* Send Statement Email Dialog */}
        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
          onSuccess={() => {
            setShowEmailDialog(false);
            toast.success("Statement sent to customer");
          }}
        />

        {/* Bulk Generation Progress */}
        {isBulkGenerating && (
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-4">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Generating statements... {bulkProgress.current}/{bulkProgress.total}</p>
                  <Progress value={(bulkProgress.current / Math.max(bulkProgress.total, 1)) * 100} className="mt-2 h-2" />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <ContactPreviewDrawer
        open={contactDrawerOpen}
        onOpenChange={setContactDrawerOpen}
        contactId={contactDrawerId}
      />
    </>
  );
}
