import { useState, useEffect, useRef, useCallback } from "react";
import { ESTIMATE_IMPORT_FIELDS } from "@/lib/importConfigs/estimateImportConfig";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useEstimates, Estimate, EstimateItem } from "@/hooks/useEstimates";
import { useContacts } from "@/hooks/useContacts";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { useExport } from "@/hooks/useExport";
import { useViewMode } from "@/hooks/useViewMode";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { useSession } from "@/contexts/SessionContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { BulkActionsToolbar } from "@/components/common/BulkActionsToolbar";
import { BulkDeleteDialog } from "@/components/common/BulkDeleteDialog";
import { BulkExportEstimatesDialog } from "@/components/estimates/BulkExportEstimatesDialog";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver, ProductResolver } from "@/lib/entityResolver";
import { ImportResults, BatchImportFn } from "@/hooks/useImport";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
  FileText,
  Trash2,
  Edit,
  Send,
  ArrowRightLeft,
  Download,
  X,
  Printer,
  Mail,
  ShoppingCart,
  Upload,
} from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { format } from "date-fns";
import { AdditionalCost } from "@/components/common/AdditionalCostsSection";
// Phase-3: CreateEstimateDialog / EditEstimateDialog retired.
// Create + edit now live as `/sales/estimates/new` and
// `/sales/estimates/:id/edit` routes on top of RecordFormShell.
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildSalesEstimateSnapshot } from "@/services/documents/snapshots/salesEstimate";

import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { EstimatePeekSheet } from "@/features/sales/estimates/EstimatePeekSheet";
import { usePeekParam } from "@/features/sales/record";
import { EstimateListTable } from "@/components/estimates/EstimateListTable";
import { normalizeError } from "@/services/resilience";
import { printOutcomeToast } from "@/services/printing/printOutcomeToast";

export default function Estimates() {
  // View mode state
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "estimate" });

  // Core field display overrides from Studio
  const coreFieldDisplay = useCoreFieldDisplay("estimate");

  // Default list columns - can be overridden by saved list views in Studio
  const defaultEstimateColumns: DefaultColumn[] = coreFieldDisplay.applyToColumns([
    { field: "estimate_number", label: "Estimate #", visible: true },
    { field: "customer", label: "Customer", visible: true },
    { field: "issue_date", label: "Issue Date", visible: true },
    { field: "expiry_date", label: "Expiry Date", visible: true },
    { field: "status", label: "Status", visible: true },
    { field: "amount", label: "Amount", visible: true },
  ]);
  const { visibleColumns } = useListViewColumns("estimate", defaultEstimateColumns);
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Custom field filtering
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("estimate");

  const { estimates, isLoading, createEstimate, getNextEstimateNumber, updateEstimate, deleteEstimate, convertToInvoice, convertToSalesOrder, refreshEstimates } = useEstimates();
  const { contacts } = useContacts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { exportToCSV } = useExport();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { canManageSales } = usePermissions();
  const { userRole } = useSession();
  const isAdmin = userRole === "admin" || userRole === "owner" || userRole === "super_admin";

  const navigate = useNavigate();

  // Handle ?action=create from GlobalCreateMenu — routes to the new /new page.
  useEffect(() => {
    if (searchParams.get("action") === "create") {
      const contactId = searchParams.get("contact_id");
      const qs = contactId ? `?contact_id=${encodeURIComponent(contactId)}` : "";
      // Consume the params so we don't loop.
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      next.delete("contact_id");
      setSearchParams(next, { replace: true });
      navigate(`/sales/estimates/new${qs}`);
    }
  }, [searchParams, navigate, setSearchParams]);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  
  const [detailEstimate, setDetailEstimate] = useState<Estimate | null>(null);
  const [peekId, setPeek] = usePeekParam();
  const contactResolverRef = useRef<ContactResolver | null>(null);
  const productResolverRef = useRef<ProductResolver | null>(null);

  const estimateFieldDefinitions = ESTIMATE_IMPORT_FIELDS;

  const handleBatchImportEstimate: BatchImportFn = useCallback(async (rows) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected. Pick a company before importing.");

    if (!contactResolverRef.current) {
      contactResolverRef.current = new ContactResolver(currentOrg.id, currentBusiness.id, "customer", contacts);
    }

    const groups = new Map<string, Record<string, any>[]>();
    rows.forEach((row, idx) => {
      const key = row.reference || `__single_${idx}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    });

    const results: ImportResults = { total: rows.length, imported: 0, skipped: 0, errors: [] };

    for (const [, groupRows] of groups) {
      try {
        const firstRow = groupRows[0];
        const resolved = await contactResolverRef.current!.resolve(firstRow.customer_name);

        const items: Omit<EstimateItem, "id" | "estimate_id">[] = groupRows.map((row) => {
          const quantity = Number(row.quantity) || 1;
          const unitPrice = Number(row.unit_price) || 0;
          const taxRate = Number(row.tax_rate) || 0;
          const discountPercent = Number(row.discount_percent) || 0;
          const subtotal = quantity * unitPrice;
          const discount = subtotal * (discountPercent / 100);
          const afterDiscount = subtotal - discount;
          const taxAmount = afterDiscount * (taxRate / 100);

          return {
            product_id: null,
            description: row.item_description,
            quantity,
            unit_price: unitPrice,
            tax_rate: taxRate,
            tax_amount: taxAmount,
            discount_percent: discountPercent,
            line_total: afterDiscount,
            sort_order: 0,
          };
        });

        const estimateNumber = await getNextEstimateNumber();
        await createEstimate(
          {
            estimate_number: estimateNumber,
            contact_id: resolved.id,
            status: "draft",
            issue_date: new Date().toISOString().split("T")[0],
            expiry_date: firstRow.expiry_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
            subtotal: 0,
            tax_amount: 0,
            discount_amount: 0,
            total: 0,
            currency: baseCurrency,
            notes: firstRow.notes || null,
            terms: null,
            converted_invoice_id: null,
            converted_at: null,
            customer_signature_url: null,
            signed_at: null,
            signed_by_name: null,
            signed_by_email: null,
          },
          items
        );
        results.imported += groupRows.length;
      } catch (error: any) {
        groupRows.forEach((row, idx) => {
          results.errors.push({ rowIndex: idx, data: row, errors: error.message || "Unknown error" });
        });
      }
    }
    return results;
  }, [currentOrg, contacts, baseCurrency, createEstimate, getNextEstimateNumber]);

  const handleImportComplete = () => {
    contactResolverRef.current = null;
    productResolverRef.current = null;
    refreshEstimates();
  };
  
  // Edit surface is now the `/sales/estimates/:id/edit` route.
  const [selectedEstimate, setSelectedEstimate] = useState<Estimate | null>(null);
  
  // Email dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  
  // Wave 7.2 — print goes straight down the canonical document pipeline
  // (snapshot → document_records → output intent). The preview dialog is
  // kept as an operator-facing fallback surface only; it is no longer the
  // print path, so rapid Sales prints can't get bounced off the raw FIFO
  // hardware route by an ask_user/error branch.
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState("");
  const [printDocumentId, setPrintDocumentId] = useState("");
  const [printCommunication, setPrintCommunication] =
    useState<Parameters<typeof PrintPreviewDialog>[0]["communication"]>(undefined);
  const isGeneratingPdf = false;

  
  // Bulk operations state
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [showBulkExportDialog, setShowBulkExportDialog] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Prefill from URL params
  const [prefillContactId, setPrefillContactId] = useState<string | null>(null);

  const customers = contacts.filter((c) => (c.type === "customer" || c.type === "both") && c.is_active);

  // Handle ?id= or ?edit= URL parameter to auto-open detail dialog
  useEffect(() => {
    const deepLinkId = searchParams.get("id") || searchParams.get("edit");
    if (!deepLinkId || isLoading) return;

    const target = estimates.find((e) => e.id === deepLinkId);
    if (target) {
      setDetailEstimate(target);
      setPeek(deepLinkId);
      const next = new URLSearchParams(searchParams);
      next.delete("id");
      next.delete("edit");
      setSearchParams(next, { replace: true });
    } else if (estimates.length > 0) {
      supabase
        .from("estimates")
        .select("*, contact:contacts(name, email)")
        .eq("id", deepLinkId)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setDetailEstimate(data as unknown as Estimate);
            setPeek(deepLinkId);
          }
          const next = new URLSearchParams(searchParams);
          next.delete("id");
          next.delete("edit");
          setSearchParams(next, { replace: true });
        });
    }
  }, [estimates, searchParams, isLoading, setSearchParams, setPeek]);

  const handleEditEstimate = (estimate: Estimate) => {
    if (estimate.status !== "draft") {
      toast({
        title: "Cannot edit",
        description: "Only draft estimates can be edited.",
        variant: "destructive",
      });
      return;
    }
    setSelectedEstimate(estimate);
    navigate(`/sales/estimates/${estimate.id}/edit`);
  };

  const handleSendEmail = (estimate: Estimate) => {
    setEmailDocument({
      documentType: "estimate",
      documentId: estimate.id,
      documentNumber: estimate.estimate_number,
      recipientEmail: estimate.contact?.email || "",
      recipientName: estimate.contact?.name || "",
      total: estimate.total,
      currency: estimate.currency || baseCurrency,
    });
    setShowEmailDialog(true);
  };

  const handleStatusChange = async (id: string, status: string) => {
    try {
      await updateEstimate(id, { status: status as any });
      toast({ title: "Status updated" });
    } catch (error: any) {
      toast({ title: "Error updating status", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleConvertToInvoice = async (id: string) => {
    try {
      await convertToInvoice(id);
      toast({ title: "Estimate converted to invoice" });
    } catch (error: any) {
      toast({ title: "Error converting estimate", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleConvertToSalesOrder = async (id: string) => {
    try {
      await convertToSalesOrder(id);
    } catch (error: any) {
      toast({ title: "Error converting estimate", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteEstimate(id);
      toast({ title: "Estimate deleted" });
    } catch (error: any) {
      toast({ title: "Error deleting estimate", description: normalizeError(error).message, variant: "destructive" });
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

  const handlePrint = async (estimate: typeof estimates[0]) => {
    setSelectedEstimate(estimate as Estimate);
    if (!currentBusiness?.id) {
      toast({
        title: "No company selected",
        description: "Pick a company before printing estimates.",
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
      const built = await fetchAndBuildSalesEstimateSnapshot(supabase, estimate.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.estimate",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "estimate",
        sourceDocId: estimate.id,
        businessId: built.businessId ?? currentBusiness.id,
        branchId: built.branchId ?? null,
        partyKind: "customer",
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      await acknowledgeRecordPrint(
        { documentRecordId, triggeredSource: "manual" },
        toast,
        { label: `Estimate ${estimate.estimate_number}` },
      );
    } catch (err) {
      toast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };


  const filteredEstimates = estimates.filter((est) => {
    const matchesSearch =
      est.estimate_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      est.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || est.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Bulk selection - use filtered estimates for current page selection
  const {
    selectedCount,
    selectedItems,
    isAllSelected,
    isPartiallySelected,
    toggleItem,
    toggleAll,
    clearSelection,
    isSelected,
  } = useBulkSelection({
    items: filteredEstimates,
    getItemId: (estimate) => estimate.id,
  });

  // Get deletable estimates from selection (admins can delete any, others only drafts)
  const selectedDraftEstimates = isAdmin 
    ? selectedItems 
    : selectedItems.filter((e) => e.status === "draft");

  // Bulk delete handler
  const handleBulkDelete = async () => {
    if (selectedDraftEstimates.length === 0) {
      toast({
        title: "Cannot delete",
        description: isAdmin 
          ? "No estimates selected for deletion." 
          : "Only draft estimates can be deleted. Select at least one draft estimate.",
        variant: "destructive",
      });
      return;
    }

    setIsBulkDeleting(true);
    try {
      for (const estimate of selectedDraftEstimates) {
        await deleteEstimate(estimate.id);
      }
      toast({
        title: "Estimates deleted",
        description: `Successfully deleted ${selectedDraftEstimates.length} estimate(s).`,
      });
      clearSelection();
      setShowBulkDeleteDialog(false);
    } catch (error: any) {
      toast({
        title: "Error deleting estimates",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      draft: "secondary",
      sent: "default",
      viewed: "default",
      accepted: "default",
      rejected: "destructive",
      expired: "destructive",
      converted: "outline",
    };
    return <Badge variant={variants[status] || "secondary"}>{status}</Badge>;
  };

  const totals = {
    total: filteredEstimates.reduce((sum, e) => sum + e.total, 0),
    pending: filteredEstimates.filter((e) => ["draft", "sent", "viewed"].includes(e.status)).reduce((sum, e) => sum + e.total, 0),
    accepted: filteredEstimates.filter((e) => e.status === "accepted").reduce((sum, e) => sum + e.total, 0),
  };




  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">Estimates</h1>
              {currentOrg && (
                <RefreshButton queryKeyPrefixes={[queryKeys.estimates.all(currentOrg.id)]} tooltip="Refresh estimates" />
              )}
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">Create and manage quotes for your customers</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="estimate" />
            <StudioQuickPanelTrigger entityType="estimate" />
            <ViewSwitcher
              entityType="estimate"
              currentView={currentView}
              onViewChange={setView}
            />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "estimate_number", header: "Estimate #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 25 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
                ];
                const rows = filteredEstimates.map((est) => ({
                  estimate_number: est.estimate_number,
                  date: est.issue_date,
                  customer: est.contact?.name || "",
                  status: est.status,
                  total: est.total,
                }));
                return {
                  title: "Estimates Register",
                  columns: cols,
                  rows,
                } as ExportConfig;
              }}
            />
            {canManageSales && (
              <>
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" /> Import
                </Button>
                <Button onClick={() => navigate("/sales/estimates/new")} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" /> Create Estimate
                </Button>
              </>
            )}
          </div>
        </div>

        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Estimate"
          fieldDefinitions={estimateFieldDefinitions}
          onImport={async () => {}}
          onBatchImport={handleBatchImportEstimate}
          onComplete={handleImportComplete}
        />

        <div className="stats-grid">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">Total Estimates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="stat-value">{formatCurrency(totals.total, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{filteredEstimates.length} estimates</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">Pending</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-warning">{formatCurrency(totals.pending, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">Accepted</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-green-600">{formatCurrency(totals.accepted, baseCurrency)}</div>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search estimates..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 w-full" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <CustomFieldFilters entityType="estimate" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        {/* Dynamic Views */}
        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={filteredEstimates as unknown as Record<string, unknown>[]}
        />

        {currentView === "list" && (
          <EstimateListTable
            estimates={filteredEstimates}
            isLoading={isLoading}
            currencyReady={currencyReady}
            isAdmin={isAdmin}
            canManageSales={canManageSales}
            isSelected={isSelected}
            isAllSelected={isAllSelected}
            isPartiallySelected={isPartiallySelected}
            toggleItem={toggleItem}
            toggleAll={toggleAll}
            onViewDetail={(est) => { setDetailEstimate(est); setPeek(est.id); }}
            onEdit={handleEditEstimate}
            onStatusChange={handleStatusChange}
            onConvertToInvoice={handleConvertToInvoice}
            onConvertToSalesOrder={handleConvertToSalesOrder}
            onDelete={handleDelete}
            onPrint={handlePrint}
            onSendEmail={handleSendEmail}
          />
        )}
      </div>

      {/* Create + edit surfaces are now dedicated routes:
          /sales/estimates/new  and  /sales/estimates/:id/edit */}


      {/* Send Email Dialog */}
      <SendDocumentDialog
        open={showEmailDialog}
        onOpenChange={setShowEmailDialog}
        document={emailDocument}
        onSuccess={refreshEstimates}
      />

      {/* Estimate peek sheet — standard Sales `?peek=<id>` surface */}
      <EstimatePeekSheet
        estimateId={peekId}
        onOpenChange={(o) => { if (!o) setPeek(null); }}
      />

      {/* Print Preview Dialog */}
      <PrintPreviewDialog
        open={printPreviewOpen}
        onOpenChange={setPrintPreviewOpen}
        title={printPreviewTitle}
        documentType={printDocumentType}
        documentId={printDocumentId}
        filename={`estimate-${printPreviewTitle.replace('Estimate ', '')}`}
        communication={printCommunication}
      />

      {/* Bulk Delete Dialog */}
      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedDraftEstimates.length}
        entityName={selectedDraftEstimates.length === 1 ? "estimate" : "estimates"}
        onConfirm={handleBulkDelete}
        isDeleting={isBulkDeleting}
      />

      {/* Bulk Export Dialog */}
      <BulkExportEstimatesDialog
        open={showBulkExportDialog}
        onOpenChange={setShowBulkExportDialog}
        selectedEstimates={selectedItems}
        allEstimates={filteredEstimates}
      />

      {/* Bulk Actions Toolbar */}
      <BulkActionsToolbar
        selectedCount={selectedCount}
        onDelete={() => setShowBulkDeleteDialog(true)}
        onExport={() => setShowBulkExportDialog(true)}
        onClearSelection={clearSelection}
        isDeleting={isBulkDeleting}
        entityName={selectedCount === 1 ? "estimate" : "estimates"}
      />
    </>
  );
}
