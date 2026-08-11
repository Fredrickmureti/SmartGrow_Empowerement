import { useState, useRef, useCallback, useEffect } from "react";
import { PurchaseOrderRowActions } from "@/features/purchases/orders/PurchaseOrderRowActions";
import { PURCHASE_ORDER_IMPORT_FIELDS } from "@/lib/importConfigs/purchaseOrderImportConfig";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { useSearchParams, useNavigate } from "react-router-dom";
import { usePurchaseOrders, PurchaseOrderItem, PurchaseOrder } from "@/hooks/usePurchaseOrders";
import { usePaginatedListQuery } from "@/hooks/usePaginatedListQuery";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { useBills } from "@/hooks/useBills";
import { useContacts } from "@/hooks/useContacts";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { supabase } from "@/integrations/supabase/client";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { useVendorPriceLists } from "@/hooks/useVendorPriceLists";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver, ProductResolver } from "@/lib/entityResolver";
import { ImportResults, BatchImportFn } from "@/hooks/useImport";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Send,
  ArrowRightLeft,
  Package,
  Download,
  Mail,
  Pencil,
  Printer,
  Loader2,
  Upload,
} from "lucide-react";
import { useExport } from "@/hooks/useExport";
import { format } from "date-fns";
import { Ban } from "lucide-react";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
// GoodsReceiptDialog retired — Goods Receipt is now a WizardShell route at
// /warehouse-app/receiving?source_doc_type=purchase_order&source_doc_id=<id>:
// receiving is captured once, in the WMS receiving session (GRN convergence).
// EditPODialog retired — editing is now the RecordShell route at
// /purchases/orders/:id/edit. See src/features/purchases/orders/PurchaseOrderEditPage.tsx.
// Create-PO dialog retired — creation is now the RecordFormShell route at
// /purchases/orders/new. See src/features/purchases/orders/PurchaseOrderCreatePage.tsx.
import { useBranches } from "@/hooks/useBranches";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildPurchasesPoSnapshot } from "@/services/documents/snapshots/purchasesPo";
import { usePermissions } from "@/hooks/usePermissions";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { PurchaseOrderPeekSheet } from "@/features/purchases/orders/PurchaseOrderPeekSheet";
import { usePeekParam } from "@/design-system";
import { normalizeError } from "@/services/resilience";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

// Workflow pipeline for Purchase Orders
function POWorkflowPipeline({ status }: { status: string }) {
  const steps = [
    { key: "draft", label: "Draft" },
    { key: "submitted", label: "Submitted" },
    { key: "approved", label: "Approved" },
    { key: "sent", label: "Sent" },
    { key: "received", label: "Received" },
  ];

  const getActiveStep = () => {
    switch (status) {
      case "draft":
      case "revised":
        return 0;
      case "submitted":
        return 1;
      case "approved":
        return 2;
      case "sent":
      case "acknowledged":
        return 3;
      case "partial_received":
        return 3;
      case "received":
      case "closed":
        return 4;
      default:
        return 0;
    }
  };

  const activeStep = getActiveStep();

  if (status === "cancelled" || status === "rejected") {
    return (
      <div className="flex items-center gap-1">
        <Ban className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs text-destructive font-medium">
          {status === "rejected" ? "Rejected" : "Cancelled"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-0.5">
          <div
            className={`h-2 w-2 rounded-full transition-colors ${
              i <= activeStep
                ? i === activeStep
                  ? "bg-primary ring-2 ring-primary/30"
                  : "bg-primary"
                : "bg-muted-foreground/20"
            }`}
            title={step.label}
          />
          {i < steps.length - 1 && (
            <div className={`h-[1.5px] w-3 ${i < activeStep ? "bg-primary" : "bg-muted-foreground/20"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function PurchaseOrders() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { getNextPONumber, createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, convertToBill, releasePurchaseOrder, refreshPurchaseOrders } = usePurchaseOrders();
  const { confirmBill, refreshBills } = useBills();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { exportPurchaseOrders } = useExport();
  const { toast } = useToast();
  const { canManagePurchases } = usePermissions();

  const [showImportWizard, setShowImportWizard] = useState(false);

  // Handle ?action=create from global create menu — redirect to /new route
  useEffect(() => {
    if (searchParams.get("action") === "create") {
      const params = new URLSearchParams();
      const cid = searchParams.get("contact_id");
      const pid = searchParams.get("project_id");
      if (cid) params.set("contact_id", cid);
      if (pid) params.set("project_id", pid);
      const q = params.toString();
      navigate(`/purchases/orders/new${q ? `?${q}` : ""}`, { replace: true });
    }
  }, [searchParams, navigate]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const urlStatus = new URLSearchParams(window.location.search).get("status");
    return urlStatus || "all";
  });
  const [dateFrom, setDateFrom] = useState("");
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState("");
  const {
    data: purchaseOrders,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    refetch: refetchPurchaseOrders,
  } = usePaginatedListQuery<PurchaseOrder>({
    cacheKey: "purchase_orders",
    table: "purchase_orders",
    select: "*, vendor:contacts(name, email)",
    search: searchQuery || undefined,
    searchColumns: ["po_number"],
    status: statusFilter,
    extra: (q) => {
      if (dateFrom) q = q.gte("order_date", dateFrom);
      if (dateTo) q = q.lte("order_date", dateTo);
      return q;
    },
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const contactResolverRef = useRef<ContactResolver | null>(null);
  const productResolverRef = useRef<ProductResolver | null>(null);

  const poFieldDefinitions = PURCHASE_ORDER_IMPORT_FIELDS;

  const handleBatchImportPO: BatchImportFn = useCallback(async (rows) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected. Pick a company before importing.");

    if (!contactResolverRef.current) {
      contactResolverRef.current = new ContactResolver(currentOrg.id, currentBusiness.id, "supplier", contacts.filter(c => c.type === "supplier" || c.type === "both"));
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
        const resolved = await contactResolverRef.current!.resolve(firstRow.vendor_name);

        const items = groupRows.map((row) => {
          const quantity = Number(row.quantity) || 1;
          const unitPrice = Number(row.unit_price) || 0;
          const taxRate = Number(row.tax_rate) || 0;
          const lineTotal = quantity * unitPrice;
          const taxAmount = lineTotal * (taxRate / 100);

          return {
            product_id: null,
            description: row.item_description,
            quantity,
            quantity_received: 0,
            unit_price: unitPrice,
            tax_rate: taxRate,
            tax_amount: taxAmount,
            line_total: lineTotal,
            sort_order: 0,
          };
        });

        await createPurchaseOrder(
          {
            po_number: await getNextPONumber(),
            vendor_id: resolved.id,
            status: "draft",
            order_date: firstRow.order_date || new Date().toISOString().split("T")[0],
            expected_date: firstRow.expected_date || null,
            subtotal: 0,
            tax_amount: 0,
            discount_amount: 0,
            total: 0,
            currency: baseCurrency,
            shipping_address: null,
            notes: firstRow.notes || null,
            converted_bill_id: null,
            converted_at: null,
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
  }, [currentOrg, contacts, baseCurrency, createPurchaseOrder, getNextPONumber]);

  const handleImportComplete = () => {
    contactResolverRef.current = null;
    productResolverRef.current = null;
    refreshPurchaseOrders();
    refetchPurchaseOrders();
  };

  // Send email dialog
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);

  const [isPrinting, setIsPrinting] = useState<string | null>(null);
  const [peekId, setPeekId] = usePeekParam();


  const handlePrintPO = async (po: PurchaseOrder) => {
    if (!currentBusiness?.id) {
      toast({ title: "No company selected", description: "Pick a company before printing.", variant: "destructive" });
      return;
    }
    if (!currentOrg?.id) {
      toast({ title: "No organization", description: "Sign in to an organization before printing.", variant: "destructive" });
      return;
    }
    setIsPrinting(po.id);
    try {
      const built = await fetchAndBuildPurchasesPoSnapshot(supabase, po.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "purchases.po",
        organizationId: currentOrg.id,
        sourceModule: "purchases",
        sourceDocType: "purchase_order",
        sourceDocId: po.id,
        businessId: built.businessId ?? currentBusiness.id,
        branchId: built.branchId ?? currentBranch?.id ?? null,
        partyKind: "supplier",
        partyId: built.vendorId,
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      await acknowledgeRecordPrint(
        { documentRecordId, triggeredSource: "manual" },
        toast,
        { label: `PO ${po.po_number}` },
      );
    } catch (err) {
      toast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsPrinting(null);
    }
  };


  /**
   * Emailing an approved PO to the supplier *is* the release. Anything else
   * (draft, already sent, cancelled) keeps its status — the state machine
   * decides, the list page never writes a status directly.
   */
  const handleReleaseAfterEmail = async (id: string) => {
    if (!id) return;
    const po = purchaseOrders.find((p) => p.id === id);
    if (po?.status !== "approved") return;
    try {
      await releasePurchaseOrder(id);
      toast({ title: "Purchase order released to supplier" });
    } catch (error: any) {
      toast({ title: "Error releasing purchase order", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleConvertToBill = async (id: string) => {
    try {
      const bill = await convertToBill(id);
      // Auto-confirm the converted bill to post to GL (like direct bill creation)
      if (bill?.id) {
        try {
          await confirmBill(bill.id);
          await refreshBills();
          toast({ title: "PO converted to bill", description: "Bill has been confirmed and posted to the General Ledger." });
        } catch (glError: any) {
          console.error("Auto GL posting failed for converted bill:", glError);
          toast({
            title: "PO converted to draft bill",
            description: `GL posting failed: ${glError?.message || "Unknown error"}. Please confirm the bill manually.`,
            variant: "destructive",
          });
        }
        navigate(`/purchases/bills?id=${bill.id}`);
      }
    } catch (error: any) {
      toast({ title: "Error converting PO", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePurchaseOrder(id);
      toast({ title: "Purchase order deleted" });
    } catch (error: any) {
      toast({ title: "Error deleting PO", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  // Filtering and pagination handled server-side via usePaginatedListQuery above.
  const filteredPOs = purchaseOrders;

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      draft: "secondary",
      submitted: "outline",
      approved: "default",
      rejected: "destructive",
      sent: "default",
      acknowledged: "default",
      partial_received: "outline",
      received: "default",
      closed: "secondary",
      revised: "secondary",
      cancelled: "destructive",
    };
    const colors: Record<string, string> = { received: "bg-green-500" };
    return <Badge variant={variants[status]} className={colors[status]}>{status.replace("_", " ")}</Badge>;
  };

  const totals = {
    total: filteredPOs.reduce((sum, po) => sum + po.total, 0),
    pending: filteredPOs.filter((po) => ["draft", "submitted", "approved", "sent", "acknowledged"].includes(po.status)).reduce((sum, po) => sum + po.total, 0),
    partialReceived: filteredPOs.filter((po) => po.status === "partial_received").length,
    received: filteredPOs.filter((po) => po.status === "received").length,
    convertedToBill: filteredPOs.filter((po) => po.converted_bill_id).length,
  };


  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Purchase Orders</h1>
            <p className="text-sm sm:text-base text-muted-foreground">Create and manage orders to suppliers</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="purchase_order" />
            <StudioQuickPanelTrigger entityType="purchase_order" />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "po_number", header: "PO #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "supplier", header: "Supplier", width: 25 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "total", header: "Total", format: "currency", width: 16, align: "right" },
                ];
                const rows = filteredPOs.map((po) => ({
                  po_number: po.po_number,
                  date: po.order_date,
                  supplier: po.vendor?.name || "",
                  status: po.status,
                  total: po.total,
                }));
                return {
                  title: "Purchase Orders Report",
                  companyName: currentOrg?.name,
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                  organizationId: currentOrg?.id,
                } as ExportConfig;
              }}
            />
            {canManagePurchases && (
              <>
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" /> Import
                </Button>
                <ScanToDocumentButton createPath="/purchases/orders/new" label="Scan to PO" />
                <Button onClick={() => navigate("/purchases/orders/new")} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" /> Create PO
                </Button>
              </>
            )}
          </div>
        </div>

        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Purchase Order"
          fieldDefinitions={poFieldDefinitions}
          onImport={async () => {}}
          onBatchImport={handleBatchImportPO}
          onComplete={handleImportComplete}
        />

        <div className="stats-grid grid-cols-2 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(totals.total, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{filteredPOs.length} purchase orders</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-600">{formatCurrency(totals.pending, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Partially Received</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{totals.partialReceived}</div>
              <p className="text-xs text-muted-foreground">Awaiting remaining</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Received & Billed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-emerald-600">{totals.received}</div>
              <p className="text-xs text-muted-foreground">{totals.convertedToBill} converted to bill</p>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search purchase orders..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 w-full" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="submitted">Submitted</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="acknowledged">Acknowledged</SelectItem>
              <SelectItem value="partial_received">Partial</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="revised">Revised</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full sm:w-[150px]"
          />
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full sm:w-[150px]"
          />
          {(dateFrom || dateTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>
              Clear dates
            </Button>
          )}
        </div>

        <div className="table-container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO #</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Order Date</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(isLoading || !currencyReady) ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8">Loading...</TableCell></TableRow>
              ) : filteredPOs.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No purchase orders found</TableCell></TableRow>
              ) : (
                filteredPOs.map((po) => (
                  <TableRow key={po.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setPeekId(po.id)}>
                    <TableCell className="font-medium">
                      {po.po_number}
                      {po.notes?.includes("Auto-generated by replenishment") && (
                        <Badge variant="outline" className="ml-2 text-xs">Auto</Badge>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {po.vendor ? (
                        <ClickableEntity onClick={() => setPreviewContactId(po.vendor_id)}>
                          {po.vendor.name}
                        </ClickableEntity>
                      ) : "—"}
                    </TableCell>
                    <TableCell>{format(new Date(po.order_date), "MMM d, yyyy")}</TableCell>
                    <TableCell>{po.expected_date ? format(new Date(po.expected_date), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell><POWorkflowPipeline status={po.status} /></TableCell>
                    <TableCell>
                      {(() => {
                        // Phase C.6 — Odoo three-state billing model
                        const bs = (po as any).billing_status as
                          | "no" | "to_bill" | "fully_billed" | undefined;
                        if (bs === "fully_billed") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Fully Billed</Badge>;
                        if (bs === "to_bill") return <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">To Bill</Badge>;
                        return <Badge variant="secondary">Nothing to Bill</Badge>;
                      })()}
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(po.total, po.currency)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <PurchaseOrderRowActions
                        po={po}
                        onPeek={setPeekId}
                        onChanged={() => { refreshPurchaseOrders(); void refetchPurchaseOrders(); }}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <DataTablePagination
          pagination={pagination}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          isLoading={isFetching}
        />
      </div>


      {/* Send to Vendor Email Dialog */}
      <SendDocumentDialog
        open={showEmailDialog}
        onOpenChange={setShowEmailDialog}
        document={emailDocument}
        onSuccess={() => {
          void handleReleaseAfterEmail(emailDocument?.documentId || "");
        }}
      />

      {/* PO peek surface */}
      <PurchaseOrderPeekSheet
        poId={peekId}
        onOpenChange={(open) => { if (!open) setPeekId(null); }}
      />


      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId}
      />
    </>
  );
}
