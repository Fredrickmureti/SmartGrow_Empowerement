import { useState, useCallback, useRef, useEffect } from "react";
import { INVOICE_IMPORT_FIELDS } from "@/lib/importConfigs/invoiceImportConfig";
import { computeLine } from "@/lib/invoiceLineMath";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useInvoicesPaginated, Invoice, InvoiceItem } from "@/hooks/useInvoicesPaginated";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useExport } from "@/hooks/useExport";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useViewMode } from "@/hooks/useViewMode";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useAuth } from "@/contexts/AuthContext";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver, ProductResolver } from "@/lib/entityResolver";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, FileText, Loader2, Trash2, CheckCircle, Download, Upload, User,
} from "lucide-react";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildSalesInvoiceSnapshot } from "@/services/documents/snapshots/salesInvoice";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { InvoicePeekSheet } from "@/features/sales/invoices/InvoicePeekSheet";
import { usePeekParam } from "@/design-system/records";
// CreateInvoiceDialog retired — /sales/invoices/new hosts the create form on RecordFormShell.
import { InvoiceListTable } from "@/components/invoices/InvoiceListTable";
import { RecordPaymentDialog } from "@/components/invoices/RecordPaymentDialog";
import { PaymentHistoryDialog } from "@/components/invoices/PaymentHistoryDialog";
// EditInvoiceDialog retired — /sales/invoices/:id/edit hosts the edit form on RecordFormShell.
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { BulkDeleteDialog } from "@/components/invoices/BulkDeleteDialog";
import { BulkExportDialog } from "@/components/invoices/BulkExportDialog";
import { VoidInvoiceDialog } from "@/components/invoices/VoidInvoiceDialog";
import { useSession } from "@/contexts/SessionContext";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { format, addDays } from "date-fns";
import { normalizeError } from "@/services/resilience";
import { type ResolvedScan } from "@/hooks/scanner";
import { scanFeedbackBus } from "@/services/scanner";
import { useSalesOpenDraftHandler, useSalesHasActiveDraft } from "@/contexts/SalesScanContext";
import { dialogReadyBus } from "@/services/scanner/dialogReadyBus";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import { ScanLine } from "lucide-react";

function describeInvoicePrintError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lower = message.toLowerCase();

  if (lower.includes("column") && lower.includes("businesses") && lower.includes("currency")) {
    return "Invoice print failed while loading company branding: the company currency field is out of sync with the database schema.";
  }

  if (lower.includes("fetchandbuildsalesinvoicesnapshot")) {
    return "Invoice print failed while preparing the document snapshot. Refresh the invoice and try again.";
  }

  return normalizeError(err).message;
}

export default function Invoices() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "invoice" });
  const coreFieldDisplay = useCoreFieldDisplay("invoice");

  const defaultInvoiceColumns: DefaultColumn[] = coreFieldDisplay.applyToColumns([
    { field: "invoice_number", label: "Invoice #", visible: true },
    { field: "customer", label: "Customer", visible: true },
    { field: "salesperson", label: "Salesperson", visible: true },
    { field: "issue_date", label: "Issue Date", visible: true },
    { field: "due_date", label: "Due Date", visible: true },
    { field: "status", label: "Status", visible: true },
    { field: "amount", label: "Amount", visible: true },
    { field: "balance", label: "Balance", visible: true },
  ]);
  const { visibleColumns } = useListViewColumns("invoice", defaultInvoiceColumns);
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("invoice");

  // Search and filter state
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const urlStatus = params.get("status");
    if (urlStatus && urlStatus !== "open") return urlStatus;
    return "all";
  });
  const [agingFilter, setAgingFilter] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("aging");
  });
  // KPI deep-link convention: ?period=current_month|current_quarter|ytd|current_year|last_year
  // → derive [dateFrom, dateTo] on invoice_date. Mirrors FinancialReports.tsx.
  const computePeriodRange = (raw: string | null): { from: string; to: string } | null => {
    if (!raw) return null;
    const v = raw.toLowerCase();
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (v === "current_month") return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    if (v === "current_quarter") {
      const qStart = m - (m % 3);
      return { from: iso(new Date(y, qStart, 1)), to: iso(new Date(y, qStart + 3, 0)) };
    }
    if (v === "ytd") return { from: iso(new Date(y, 0, 1)), to: iso(now) };
    if (v === "current_year") return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) };
    if (v === "last_year") return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) };
    return null;
  };
  const [periodRange, setPeriodRange] = useState<{ from: string; to: string } | null>(() =>
    computePeriodRange(new URLSearchParams(window.location.search).get("period"))
  );
  const [myInvoicesOnly, setMyInvoicesOnly] = useState(false);

  const debouncedSearch = useDebouncedCallback((value: string) => { setSearch(value); }, 300);
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  const { user } = useAuth();
  const { getUserName, members } = useOrgMembers();
  const {
    invoices, isLoading, isFetching, pagination, setPage, setPageSize,
    createInvoice, confirmInvoice, updateInvoiceStatus, deleteInvoice, refreshInvoices,
  } = useInvoicesPaginated({
    status: statusFilter !== "all" && statusFilter !== "pos" ? statusFilter : undefined,
    search: search || undefined,
    source: statusFilter === "pos" ? "pos" : undefined,
    salespersonId: myInvoicesOnly ? user?.id : undefined,
    aging: agingFilter || undefined,
    dateFrom: periodRange?.from,
    dateTo: periodRange?.to,
  });

  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { exportInvoices } = useExport();
  const { canManageSales } = usePermissions();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { toast } = useToast();
  const { userRole } = useSession();
  // (resolveTagged removed — SalesScanContext owns scan resolution for the workspace.)
  const isAdmin = userRole === "admin" || userRole === "owner" || userRole === "super_admin";

  // Dialog states
  // Legacy dialog state — showCreateDialog kept only to satisfy the deep-link
  // effect dep array; the create + edit flows are now routes.
  const showCreateDialog = false;
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showPaymentHistory, setShowPaymentHistory] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [peekId, setPeek] = usePeekParam();
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const openingFromScanRef = useRef(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [showBulkExportDialog, setShowBulkExportDialog] = useState(false);
  const [isBulkConfirming, setIsBulkConfirming] = useState(false);

  const selectedInvoices = invoices.filter((inv) => selectedIds.has(inv.id));
  const allFilteredSelected = invoices.length > 0 && invoices.every((inv) => selectedIds.has(inv.id));
  const draftSelectedCount = selectedInvoices.filter((inv) => inv.status === "draft").length;

  // Print / preview. Primary invoice Print intentionally bypasses the
  // preview-fallback hook: that hook opens PrintPreviewDialog on ask_user/error,
  // which caused rapid Sales prints to switch away from the raw FIFO hardware
  // path while Product Labels kept queueing deterministically.
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState("");
  const [printDocumentId, setPrintDocumentId] = useState("");
  const [printCommunication, setPrintCommunication] = useState<Parameters<typeof PrintPreviewDialog>[0]["communication"]>(undefined);
  const isGeneratingPdf = false;

  // Import
  const contactResolverRef = useRef<ContactResolver | null>(null);
  const productResolverRef = useRef<ProductResolver | null>(null);
  const invoiceFieldDefinitions = INVOICE_IMPORT_FIELDS;

  // Refresh on visibility
  useEffect(() => {
    const handleVisibilityChange = () => { if (document.visibilityState === "visible") refreshInvoices(); };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refreshInvoices]);

  // Deep-link URL parameters
  useEffect(() => {
    let cancelled = false;
    const consumeParams = (keys: string[]) => {
      const next = new URLSearchParams(searchParams);
      let changed = false;
      keys.forEach((key) => { if (next.has(key)) { next.delete(key); changed = true; } });
      if (changed) setSearchParams(next, { replace: true });
    };

    const openInvoiceRecord = async (invoiceId: string) => {
      const localInvoice = invoices.find((invoice) => invoice.id === invoiceId);
      if (localInvoice) {
        if (cancelled) return true;
        setSelectedInvoice(localInvoice);
        setPeek(invoiceId);
        return true;
      }
      const { data, error } = await supabase.from("invoices").select("*, contact:contacts(name, email)").eq("id", invoiceId).eq("organization_id", currentOrg?.id || "")
.eq("business_id", currentBusiness.id).maybeSingle();
      if (cancelled || error || !data) return false;
      setSelectedInvoice(data as unknown as Invoice);
      setPeek(invoiceId);
      return true;
    };

    const handleDeepLinks = async () => {
      if (searchParams.get("action") === "create") {
        const cid = searchParams.get("contact_id");
        const params = new URLSearchParams();
        if (cid) params.set("contact_id", cid);
        const qs = params.toString();
        navigate(`/sales/invoices/new${qs ? `?${qs}` : ""}`, { replace: true });
        return;
      }
      const statusParam = searchParams.get("status");
      if (statusParam) { setStatusFilter(statusParam); consumeParams(["status"]); }
      const agingParam = searchParams.get("aging");
      if (agingParam) { setAgingFilter(agingParam); consumeParams(["aging"]); }
      const periodParam = searchParams.get("period");
      if (periodParam) {
        const range = computePeriodRange(periodParam);
        if (range) setPeriodRange(range);
        consumeParams(["period"]);
      }
      const invoiceId = searchParams.get("id") || searchParams.get("edit");
      if (invoiceId) {
        const opened = await openInvoiceRecord(invoiceId);
        if (opened) consumeParams(["id", "edit", "payment"]);
        return;
      }
      const paymentId = searchParams.get("payment");
      if (!paymentId) return;
      // ADR 0027 — deep-link from a payment opens the FIRST allocated
      // invoice (or no-op for pure customer deposits). Reads from the
      // canonical payment_allocations table, not the deprecated FK.
      const { data: alloc, error } = await supabase
        .from("payment_allocations")
        .select("invoice_id, invoice:invoices!inner(organization_id, business_id)")
        .eq("payment_id", paymentId)
        .eq("invoice.organization_id", currentOrg?.id || "")
        .eq("invoice.business_id", currentBusiness.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cancelled || error || !alloc?.invoice_id) return;
      const opened = await openInvoiceRecord(alloc.invoice_id);
      if (opened) consumeParams(["payment"]);
    };

    void handleDeepLinks();
    return () => { cancelled = true; };
  }, [searchParams, invoices, showCreateDialog, setSearchParams]);

  // Handlers
  const handleStatusChange = async (invoice: Invoice, status: Invoice["status"]) => {
    try {
      await updateInvoiceStatus(invoice.id, status);
      toast({ title: `Invoice marked as ${status}` });
    } catch (error: any) {
      toast({ title: "Error updating invoice", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const openDocumentPreview = (
    documentType: string,
    documentId: string,
    title: string,
    communication?: Parameters<typeof PrintPreviewDialog>[0]["communication"],
  ) => {
    setPrintPreviewTitle(title);
    setPrintDocumentType(documentType);
    setPrintDocumentId(documentId);
    setPrintCommunication(communication);
    setPrintPreviewOpen(true);
  };

  const handlePrintInvoice = async (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    if (!currentBusiness?.id) {
      toast({
        title: "No company selected",
        description: "Pick a company before printing invoices.",
        variant: "destructive",
      });
      return;
    }
    if (!currentOrg?.id) {
      toast({
        title: "No organization",
        description: "Sign in to an organization before printing.",
        variant: "destructive",
      });
      return;
    }

    try {
      // Wave 7.2 — canonical print pipeline: build snapshot → ensure
      // document record → submit routing intent. No direct hardware calls.
      const built = await fetchAndBuildSalesInvoiceSnapshot(supabase, invoice.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.invoice",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "invoice",
        sourceDocId: invoice.id,
        businessId: built.businessId ?? currentBusiness.id,
        branchId: built.branchId ?? currentBranch?.id ?? null,
        partyKind: "customer",
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      // Returns at the durable enqueue; render + printer happen after.
      await acknowledgeRecordPrint(
        { documentRecordId, triggeredSource: "manual" },
        toast,
        { label: `Invoice ${invoice.invoice_number}` },
      );
    } catch (err) {
      toast({
        title: "Print failed",
        description: describeInvoicePrintError(err),
        variant: "destructive",
      });
    }
  };


  const executeDelete = async (invoice: Invoice) => {
    try { await deleteInvoice(invoice.id); toast({ title: "Invoice deleted" }); } catch (error: any) { toast({ title: "Error deleting invoice", description: normalizeError(error).message, variant: "destructive" }); }
  };
  const deleteConfirm = useConfirmDelete<Invoice>({ onConfirm: executeDelete });

  const handleDelete = (invoice: Invoice) => {
    if (!isAdmin && invoice.status !== "draft") {
      toast({ title: "Cannot delete", description: "Only draft invoices can be deleted.", variant: "destructive" });
      return;
    }
    deleteConfirm.requestDelete(invoice);
  };

  const handleEditInvoice = (invoice: Invoice) => {
    if (invoice.status !== "draft") {
      toast({ title: "Cannot edit", description: "Only draft invoices can be edited.", variant: "destructive" });
      return;
    }
    navigate(`/sales/invoices/${invoice.id}/edit`);
  };

  // Sales-workspace scan routing: SalesScanContext owns the single
  // priority-5 router target for the whole Sales app. We only register
  // the "open draft with scan" handler — the context already resolves
  // the barcode for us and only calls us when no dialog is open (no
  // active controller). This eliminates the 100–300 ms blind spot that
  // existed when the Create dialog was mounting and the page-level
  // useScanTarget had already torn down.
  const openDraftFromScan = useCallback(
    (resolved: ResolvedScan) => {
      if (openingFromScanRef.current) return;
      openingFromScanRef.current = true;
      navigate("/sales/invoices/new", { state: { initialScan: resolved } });
      scanFeedbackBus.emit({
        kind: "ok",
        raw: resolved.matchedCode ?? "",
        source: "field",
        workflow: "quantity",
        fieldLabel: "Invoice list",
      });
      // Plan P5: clear the guard the instant the dialog registers its
      // scan controller (DIALOG_READY handshake) instead of guessing a
      // 600 ms timeout. The bus has its own 1500 ms safety timeout, so
      // a stuck mount still releases the guard.
      void dialogReadyBus.waitFor("sales.draft").then(() => {
        openingFromScanRef.current = false;
      });
    },
    [],
  );
  // Single source of truth: a dialog is "active" when it has registered
  // a scan controller. Avoids drift when new dialogs are added.
  const draftActive = useSalesHasActiveDraft();
  useSalesOpenDraftHandler(
    canManageSales && !draftActive && !peekId && !showPaymentDialog &&
    !showPaymentHistory && !showEmailDialog && !showVoidDialog && !showImportWizard
      ? openDraftFromScan
      : null,
  );

  // (Legacy `handleInvoiceListScan` removed — SalesScanContext is the
  // single entry point for the workspace router slot.)

  const handleSendEmail = (invoice: Invoice) => {
    setEmailDocument({
      documentType: "invoice", documentId: invoice.id, documentNumber: invoice.invoice_number,
      recipientEmail: invoice.contact?.email || "", recipientName: invoice.contact?.name || "",
      total: invoice.total, currency: invoice.currency || baseCurrency,
    });
    setShowEmailDialog(true);
  };

  const toggleSelectAll = () => { setSelectedIds(allFilteredSelected ? new Set() : new Set(invoices.map((inv) => inv.id))); };
  const toggleSelect = (id: string) => { const s = new Set(selectedIds); s.has(id) ? s.delete(id) : s.add(id); setSelectedIds(s); };

  const handleBulkDelete = async () => {
    const deletable = isAdmin ? selectedInvoices : selectedInvoices.filter((inv) => inv.status === "draft");
    for (const inv of deletable) await deleteInvoice(inv.id);
    setSelectedIds(new Set());
    toast({ title: `Deleted ${deletable.length} invoice(s)` });
  };

  const handleBulkConfirm = async () => {
    const drafts = selectedInvoices.filter((inv) => inv.status === "draft");
    if (drafts.length === 0) return;
    setIsBulkConfirming(true);
    let success = 0, errors = 0;
    for (const inv of drafts) { try { await confirmInvoice(inv.id); success++; } catch { errors++; } }
    setIsBulkConfirming(false);
    setSelectedIds(new Set());
    toast({ title: `Confirmed ${success} invoice(s)`, description: errors > 0 ? `${errors} failed` : undefined, variant: errors > 0 ? "destructive" : "default" });
  };

  const handleImportInvoice = async (row: Record<string, any>) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected. Pick a company before importing.");
    if (!contactResolverRef.current) contactResolverRef.current = new ContactResolver(currentOrg.id, currentBusiness.id, "customer", contacts);
    if (!productResolverRef.current) productResolverRef.current = new ProductResolver(currentOrg.id, currentBusiness.id, products);
    const resolved = await contactResolverRef.current.resolve(row.customer_name);
    const quantity = Number(row.quantity) || 1;
    const unitPrice = Number(row.unit_price) || 0;
    const taxRate = Number(row.tax_rate) || 0;
    const discountPercent = Number(row.discount_percent) || 0;
    // Use canonical math: line_total is tax-EXCLUSIVE (matches confirm_invoice_atomic).
    const { line_total, tax_amount } = computeLine({
      quantity,
      unit_price: unitPrice,
      discount_percent: discountPercent,
      tax_rate: taxRate,
    });
    await createInvoice(
      { contact_id: resolved.id, due_date: row.due_date || format(addDays(new Date(), 30), "yyyy-MM-dd"), notes: row.notes || undefined, currency: baseCurrency, status: "draft" },
      [{ description: row.item_description, quantity, unit_price: unitPrice, tax_rate: taxRate, tax_amount, discount_percent: discountPercent, line_total, sort_order: 0 }]
    );
  };
  const handleImportComplete = () => { contactResolverRef.current = null; productResolverRef.current = null; refreshInvoices(); };

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Invoices</h1>
              <p className="text-sm sm:text-base text-muted-foreground">Create and manage invoices</p>
            </div>
            <RefreshButton queryKeyPrefixes={[queryKeys.invoices.all(currentOrg?.id || ""), queryKeys.reports.aging(currentOrg?.id || "")]} tooltip="Refresh invoices" />
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="invoice" />
            <StudioQuickPanelTrigger entityType="invoice" />
            <ViewSwitcher entityType="invoice" currentView={currentView} onViewChange={setView} />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "invoice_number", header: "Invoice #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 25 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
                  { key: "paid", header: "Paid", format: "currency", width: 14, align: "right" },
                  { key: "balance", header: "Balance", format: "currency", width: 14, align: "right" },
                ];
                const rows = invoices.map((inv) => ({
                  invoice_number: inv.invoice_number, date: inv.issue_date, customer: inv.contact?.name || "",
                  status: inv.status, total: inv.total, paid: inv.amount_paid, balance: inv.total - inv.amount_paid,
                }));
                return { title: "Invoice Register", companyName: currentOrg?.name, columns: cols, rows, currency: baseCurrency, organizationId: currentOrg?.id } as ExportConfig;
              }}
            />
            {canManageSales && (
              <>
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" />Import
                </Button>
                {handheldScanner ? (
                  /* On the device the operator is holding, the camera IS the
                     input device: go straight into a Scan Session on a fresh
                     draft instead of offering to pair another phone. */
                  <Button
                    variant="outline"
                    onClick={() =>
                      navigate("/sales/invoices/new", { state: { openScanSession: true } })
                    }
                    className="flex-1 sm:flex-none"
                  >
                    <ScanLine className="mr-2 h-4 w-4" />Scan to invoice
                  </Button>
                ) : (
                  <ScannerPairingButton
                    businessId={currentBusiness?.id}
                    branchId={currentBranch?.id ?? null}
                    label="Invoice creation"
                    className="flex-1 sm:flex-none"
                  />
                )}
                <Button onClick={() => navigate("/sales/invoices/new")} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" />Create Invoice
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Filters and Bulk Actions */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="filter-bar flex-1">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search invoices..." value={searchInput} onChange={handleSearchChange} className="pl-10 w-full" />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="open">Open (Outstanding)</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="partial">Partial</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="cancelled">Cancelled/Voided</SelectItem>
                <SelectItem value="pos">POS Sales</SelectItem>
              </SelectContent>
            </Select>
            {agingFilter && (
              <Badge variant="secondary" className="cursor-pointer hover:bg-destructive/20" onClick={() => setAgingFilter(null)}>
                Aging: {agingFilter} ✕
              </Badge>
            )}
            <Button variant={myInvoicesOnly ? "default" : "outline"} size="sm" onClick={() => setMyInvoicesOnly(!myInvoicesOnly)} className="whitespace-nowrap">
              <User className="mr-2 h-4 w-4" />My Invoices
            </Button>
          </div>
          {selectedIds.size > 0 && (
            <div className="bulk-toolbar">
              <span className="text-sm font-medium whitespace-nowrap">{selectedIds.size} selected</span>
              <div className="flex gap-2 flex-wrap">
                {draftSelectedCount > 0 && (
                  <Button variant="default" size="sm" onClick={handleBulkConfirm} disabled={isBulkConfirming}>
                    {isBulkConfirming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
                    Confirm {draftSelectedCount} Draft{draftSelectedCount > 1 ? "s" : ""}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setShowBulkExportDialog(true)}><Download className="mr-2 h-4 w-4" />Export</Button>
                <Button variant="destructive" size="sm" onClick={() => setShowBulkDeleteDialog(true)}><Trash2 className="mr-2 h-4 w-4" />Delete</Button>
              </div>
            </div>
          )}
        </div>

        <CustomFieldFilters entityType="invoice" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        <DynamicViewsRenderer currentView={currentView} selectedSavedView={selectedSavedView} data={invoices as unknown as Record<string, unknown>[]} isLoading={isLoading} />

        {/* Table */}
        {currentView === "list" && (
          <Card>
            <CardContent className="p-0">
              {(isLoading || !currencyReady) ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
              ) : invoices.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium">No invoices found</h3>
                  <p className="text-muted-foreground">
                    {!search && statusFilter === "all" ? "Create your first invoice to get started." : "Try adjusting your search or filter."}
                  </p>
                </div>
              ) : (
                <InvoiceListTable
                  invoices={invoices}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  allSelected={allFilteredSelected}
                  onViewDetails={(inv) => { setSelectedInvoice(inv); setPeek(inv.id); }}
                  onPrint={handlePrintInvoice}
                  onPreview={(inv) => { setSelectedInvoice(inv); openDocumentPreview("invoice", inv.id, `Invoice ${inv.invoice_number}`); }}
                  onEmail={handleSendEmail}
                  onEdit={handleEditInvoice}
                  onStatusChange={handleStatusChange}
                  onRecordPayment={(inv) => { setSelectedInvoice(inv); setShowPaymentDialog(true); }}
                  onViewPaymentHistory={(inv) => { setSelectedInvoice(inv); setShowPaymentHistory(true); }}
                  onViewReceipt={(inv) => { setSelectedInvoice(inv); openDocumentPreview("receipt", inv.id, `Receipt — ${inv.invoice_number}`); }}
                  onCreateCreditNote={(inv) => navigate(`/sales/credit-notes?action=create&contact_id=${inv.contact_id}&invoice_id=${inv.id}`)}
                  onCreateReturn={(inv) => navigate(`/sales/returns?action=create&contact_id=${inv.contact_id}&invoice_id=${inv.id}`)}
                  onVoid={(inv) => { setSelectedInvoice(inv); setShowVoidDialog(true); }}
                  onDelete={handleDelete}
                  onPreviewContact={setPreviewContactId}
                  isAdmin={isAdmin}
                />
              )}
            </CardContent>
          </Card>
        )}

        {invoices.length > 0 && (
          <DataTablePagination pagination={pagination} onPageChange={setPage} onPageSizeChange={setPageSize} isLoading={isFetching} />
        )}

        {/* Create Invoice moved to /sales/invoices/new route (Phase 3). */}

        {/* Detail + Action Dialogs */}
        <RecordPaymentDialog
          invoice={selectedInvoice}
          open={showPaymentDialog}
          onOpenChange={setShowPaymentDialog}
          onSuccess={async () => {
            await refreshInvoices();
            if (selectedInvoice) {
              const { data } = await supabase.from("invoices").select("*, contact:contacts(name, email, phone)").eq("id", selectedInvoice.id).eq("organization_id", currentOrg?.id || "")
.eq("business_id", currentBusiness.id).maybeSingle();
              if (data) setSelectedInvoice(data as unknown as Invoice);
            }
          }}
        />
        <PaymentHistoryDialog invoice={selectedInvoice} open={showPaymentHistory} onOpenChange={setShowPaymentHistory} />
        {/* Edit Invoice moved to /sales/invoices/:id/edit route (Phase 3). */}
        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
          onSuccess={async () => {
            if (emailDocument?.documentId) {
              const inv = invoices.find(i => i.id === emailDocument.documentId);
              if (inv && inv.status === "draft") {
                try { await updateInvoiceStatus(inv.id, "sent"); } catch (err) { console.error("Failed to confirm invoice after email send:", err); }
              }
            }
            refreshInvoices();
          }}
        />
        <PrintPreviewDialog open={printPreviewOpen} onOpenChange={setPrintPreviewOpen} title={printPreviewTitle} documentType={printDocumentType} documentId={printDocumentId} filename={`invoice-${selectedInvoice?.invoice_number || 'document'}`} communication={printCommunication} />
        <InvoicePeekSheet
          invoiceId={peekId}
          onOpenChange={(open) => { if (!open) setPeek(null); }}
        />
        <ConfirmDeleteDialog open={deleteConfirm.isOpen} onOpenChange={deleteConfirm.setIsOpen} title="Delete Invoice" itemName={deleteConfirm.itemToDelete?.invoice_number} onConfirm={deleteConfirm.confirmDelete} isLoading={deleteConfirm.isDeleting} />
        <BulkDeleteDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog} selectedInvoices={selectedInvoices} onConfirm={handleBulkDelete} />
        <BulkExportDialog open={showBulkExportDialog} onOpenChange={setShowBulkExportDialog} selectedInvoices={selectedInvoices} allInvoices={invoices} />
        <VoidInvoiceDialog invoice={selectedInvoice} open={showVoidDialog} onOpenChange={setShowVoidDialog} onReversePayment={() => { setShowVoidDialog(false); setShowPaymentHistory(true); }} onSuccess={() => { refreshInvoices(); setShowVoidDialog(false); }} />
        <ImportWizard open={showImportWizard} onOpenChange={setShowImportWizard} entityName="Invoice" fieldDefinitions={invoiceFieldDefinitions} onImport={handleImportInvoice} onComplete={handleImportComplete} />
        <ContactPreviewDrawer open={!!previewContactId} onOpenChange={(open) => { if (!open) setPreviewContactId(null); }} contactId={previewContactId || undefined} />
      </div>
    </>
  );
}
