import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useCreditNotes, CreditNote } from "@/hooks/useCreditNotes";
import { useContacts } from "@/hooks/useContacts";
import { useOrganization } from "@/hooks/useOrganization";

import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useViewMode } from "@/hooks/useViewMode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Send,
  CreditCard,
  Download,
  Mail,
  Printer,
  Eye,
  Loader2,
  RotateCcw,
  Ban,
  Edit,
} from "lucide-react";
import { useExport } from "@/hooks/useExport";
import { format } from "date-fns";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { useDocumentPrint } from "@/hooks/useDocumentPrint";
import { PermissionGate } from "@/components/common/PermissionGate";
import { CreditNotePeekSheet } from "@/features/sales/credit-notes/CreditNotePeekSheet";
import { usePeekParam } from "@/features/sales/record";
// Apply-credit + refund flows are dedicated wizard routes under
// /finance/customer-credits/:id/apply and /:id/refund — see rewires below.
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { CreditNoteListTable } from "@/components/credit-notes/CreditNoteListTable";
import { normalizeError } from "@/services/resilience";

export default function CreditNotes() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { creditNotes, isLoading, updateCreditNote, issueCreditNote, deleteCreditNote, refreshCreditNotes } = useCreditNotes();
  const { contacts } = useContacts();
  const { currentOrg } = useOrganization();
  
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { } = useExport();
  const { toast } = useToast();

  // Studio integration
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "credit_note" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("credit_note");

  
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);

  // Detail peek
  const [peekId, setPeekId] = usePeekParam();


  // Edit is now a full route (`/sales/credit-notes/:id/edit`).

  // Apply credit dialog
  const [applyCreditNote, setApplyCreditNote] = useState<CreditNote | null>(null);
  const [showApplyDialog, setShowApplyDialog] = useState(false);

  // Refund dialog
  const [refundCreditNote, setRefundCreditNote] = useState<CreditNote | null>(null);
  const [showRefundDialog, setShowRefundDialog] = useState(false);


  // Contact preview drawer
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  // Deep-link: ?id={uuid} opens peek sheet directly
  useEffect(() => {
    const id = searchParams.get("id");
    if (!id) return;
    setPeekId(id);
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setPeekId]);


  // Issue confirmation dialog
  const [issueConfirmCN, setIssueConfirmCN] = useState<CreditNote | null>(null);

  const {
    printPreviewOpen,
    setPrintPreviewOpen,
    printPreviewTitle,
    printDocumentType,
    printDocumentId,
    printCommunication,
    generateDocument,
  } = useDocumentPrint();

  // Handle ?action=create from global create menu or invoice dropdown —
  // redirect to the new create route with any pre-fill params.
  useEffect(() => {
    if (searchParams.get("action") !== "create") return;
    const contactId = searchParams.get("contact_id");
    const invoiceId = searchParams.get("invoice_id");
    const qs = new URLSearchParams();
    if (contactId) qs.set("contact_id", contactId);
    if (invoiceId) qs.set("invoice_id", invoiceId);
    navigate(`/sales/credit-notes/new${qs.toString() ? `?${qs.toString()}` : ""}`, { replace: true });
  }, [searchParams, navigate]);

  const handleIssue = async (cn: CreditNote) => {
    // If cn already has an invoice_id, show confirmation instead of asking again
    if (cn.invoice_id) {
      setIssueConfirmCN(cn);
    } else {
      try {
        await issueCreditNote(cn.id);
        toast({ title: "Credit note issued" });
      } catch (error: any) {
        toast({ title: "Error issuing credit note", description: normalizeError(error).message, variant: "destructive" });
      }
    }
  };

  const confirmIssue = async () => {
    if (!issueConfirmCN) return;
    try {
      await issueCreditNote(issueConfirmCN.id);
      toast({ title: "Credit note issued" });
      setIssueConfirmCN(null);
    } catch (error: any) {
      toast({ title: "Error issuing credit note", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const openApplyDialog = (cn: CreditNote) => {
    setApplyCreditNote(cn);
    setShowApplyDialog(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCreditNote(id);
      toast({ title: "Credit note deleted" });
    } catch (error: any) {
      toast({ title: "Error deleting", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleSendEmail = (cn: CreditNote) => {
    const contact = contacts.find(c => c.id === cn.contact_id);
    setEmailDocument({
      documentType: "credit_note",
      documentId: cn.id,
      documentNumber: cn.credit_note_number,
      recipientEmail: contact?.email || "",
      recipientName: cn.contact?.name || "",
      total: cn.total,
      currency: cn.currency || baseCurrency,
    });
    setShowEmailDialog(true);
  };

  const handlePrint = async (cn: CreditNote) => {
    await generateDocument("credit_note", cn.id, `Credit Note ${cn.credit_note_number}`, {
      entityType: "credit_note",
      entityId: cn.id,
      recipientPhone: (cn as any).contact?.phone ?? null,
      recipientName: cn.contact?.name ?? null,
      variables: {
        credit_note_number: cn.credit_note_number,
        amount: String(cn.total ?? 0),
        customer_name: cn.contact?.name ?? "",
      },
    });
  };

  const filteredCreditNotes = creditNotes.filter((cn) => {
    const matchesSearch =
      cn.credit_note_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cn.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || cn.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (cn: CreditNote) => {
    const refundAmt = cn.refund_amount || 0;
    const available = cn.total - cn.amount_applied - refundAmt;
    
    if (cn.status === "draft") return <Badge variant="secondary">Draft</Badge>;
    if (cn.status === "void") return <Badge variant="destructive">Void</Badge>;
    if (cn.status === "applied" || available <= 0.01) return <Badge className="bg-emerald-600 text-white">Fully Resolved</Badge>;
    if (cn.amount_applied > 0 || refundAmt > 0) return <Badge className="bg-amber-500 text-white">Partially Used</Badge>;
    return <Badge variant="default">Open</Badge>;
  };

  // Fixed totals: only sum issued + applied credit notes
  const activeCreditNotes = filteredCreditNotes.filter((cn) => cn.status === "issued" || cn.status === "applied");
  const totals = {
    total: activeCreditNotes.reduce((sum, cn) => sum + cn.total, 0),
    available: activeCreditNotes.reduce((sum, cn) => sum + (cn.total - cn.amount_applied - ((cn as any).refund_amount || 0)), 0),
    applied: activeCreditNotes.reduce((sum, cn) => sum + cn.amount_applied, 0),
    refunded: activeCreditNotes.reduce((sum, cn) => sum + ((cn as any).refund_amount || 0), 0),
  };





  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Credit Notes</h1>
            <p className="text-muted-foreground text-sm sm:text-base">Manage refunds and credits for customers</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="credit_note" />
            <StudioQuickPanelTrigger entityType="credit_note" />
            <RefreshButton
              queryKeyPrefixes={[
                ['credit-notes'] as const,
                ['aging-report'] as const,
              ]}
              tooltip="Refresh credit notes"
            />
            <ViewSwitcher
              entityType="credit_note"
              currentView={currentView}
              onViewChange={setView}
            />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "cn_number", header: "CN #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 22 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "amount", header: "Amount", format: "currency", width: 14, align: "right" },
                  { key: "applied", header: "Applied", format: "currency", width: 14, align: "right" },
                  { key: "available", header: "Available", format: "currency", width: 14, align: "right" },
                ];
                const rows = filteredCreditNotes.map((cn) => ({
                  cn_number: cn.credit_note_number,
                  date: cn.issue_date,
                  customer: cn.contact?.name || "",
                  status: cn.status,
                  amount: cn.total,
                  applied: cn.amount_applied,
                  available: cn.total - cn.amount_applied - ((cn as any).refund_amount || 0),
                }));
                return {
                  title: "Credit Notes Report",
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="manageSales">
              <Button onClick={() => navigate("/sales/credit-notes/new")} className="w-full sm:w-auto shrink-0">
                <Plus className="mr-2 h-4 w-4" /> Create Credit Note
              </Button>
            </PermissionGate>
          </div>
        </div>

        <div className="stats-grid grid-cols-1 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Credits</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(totals.total, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{activeCreditNotes.length} active credit notes</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Available</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">{formatCurrency(totals.available, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Applied</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-emerald-600">{formatCurrency(totals.applied, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Refunded</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-600">{formatCurrency(totals.refunded, baseCurrency)}</div>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search credit notes..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 w-full" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="issued">Issued</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
              <SelectItem value="void">Void</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <CustomFieldFilters entityType="credit_note" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={filteredCreditNotes as unknown as Record<string, unknown>[]}
          entityType="credit_note"
        />

        {currentView === "list" && (
          <CreditNoteListTable
            creditNotes={filteredCreditNotes}
            isLoading={isLoading}
            currencyReady={currencyReady}
            onViewDetail={(cn) => setPeekId(cn.id)}
            onEdit={(cn) => navigate(`/sales/credit-notes/${cn.id}/edit`)}
            onIssue={handleIssue}
            onApply={openApplyDialog}
            onRefund={(cn) => { setRefundCreditNote(cn); setShowRefundDialog(true); }}
            onVoid={(cn) => updateCreditNote(cn.id, { status: "void" as any })}
            onDelete={handleDelete}
            onSendEmail={handleSendEmail}
            onPrint={handlePrint}
            onPreviewContact={setPreviewContactId}
          />
        )}
      </div>

      {/* Create + Edit are dedicated routes under /sales/credit-notes/new and /:id/edit. */}


      {/* Issue Confirmation Dialog (for drafts with existing invoice) */}
      <Dialog open={!!issueConfirmCN} onOpenChange={(open) => { if (!open) setIssueConfirmCN(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Issue Credit Note</DialogTitle>
            <DialogDescription>
              Confirm issuing credit note <span className="font-mono font-semibold">{issueConfirmCN?.credit_note_number}</span> for{" "}
              {issueConfirmCN ? formatCurrency(issueConfirmCN.total) : ""} against invoice{" "}
              <span className="font-mono font-semibold">{issueConfirmCN?.invoice?.invoice_number || "—"}</span>?
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will post the credit note and create the corresponding journal entry (Dr Revenue, Cr Accounts Receivable).
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueConfirmCN(null)}>Cancel</Button>
            <Button onClick={confirmIssue}>
              <Send className="h-4 w-4 mr-2" /> Issue Credit Note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Credit Dialog (rich component) */}
      {applyCreditNote && (
        <ApplyCreditDialog
          open={showApplyDialog}
          onOpenChange={setShowApplyDialog}
          creditNoteId={applyCreditNote.id}
          creditNoteNumber={applyCreditNote.credit_note_number}
          contactId={applyCreditNote.contact_id || ""}
          contactName={applyCreditNote.contact?.name || "Unknown"}
          availableAmount={applyCreditNote.total - applyCreditNote.amount_applied}
          onSuccess={refreshCreditNotes}
        />
      )}

      {/* Refund Dialog */}
      {refundCreditNote && (
        <ProcessRefundDialog
          open={showRefundDialog}
          onOpenChange={setShowRefundDialog}
          creditNoteId={refundCreditNote.id}
          creditNoteNumber={refundCreditNote.credit_note_number}
          contactName={refundCreditNote.contact?.name || "Unknown"}
          totalAmount={refundCreditNote.total}
          amountApplied={refundCreditNote.amount_applied}
          amountRefunded={(refundCreditNote as any).refund_amount || 0}
          currency={refundCreditNote.currency}
          onSuccess={refreshCreditNotes}
        />
      )}

      {/* Credit Note Peek Sheet */}
      <CreditNotePeekSheet
        creditNoteId={peekId}
        onOpenChange={(o) => { if (!o) setPeekId(null); }}
      />


      <SendDocumentDialog
        open={showEmailDialog}
        onOpenChange={setShowEmailDialog}
        document={emailDocument}
      />

      <PrintPreviewDialog
        open={printPreviewOpen}
        onOpenChange={setPrintPreviewOpen}
        title={printPreviewTitle}
        documentType={printDocumentType}
        documentId={printDocumentId}
        filename={`credit-note-${printPreviewTitle.replace('Credit Note ', '')}`}
        communication={printCommunication}
      />


      {/* Contact Preview Drawer */}
      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId || undefined}
      />
    </>
  );
}
