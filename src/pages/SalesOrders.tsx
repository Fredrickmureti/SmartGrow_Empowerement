import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { SALES_ORDER_IMPORT_FIELDS } from "@/lib/importConfigs/salesOrderImportConfig";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useSalesOrders, type SalesOrder } from "@/hooks/useSalesOrders";
import { usePaginatedListQuery } from "@/hooks/usePaginatedListQuery";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { useCurrency } from "@/hooks/useCurrency";
import { useExport } from "@/hooks/useExport";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { BulkActionsToolbar } from "@/components/common/BulkActionsToolbar";
import { BulkDeleteDialog } from "@/components/common/BulkDeleteDialog";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver, ProductResolver } from "@/lib/entityResolver";
import { ImportResults, BatchImportFn } from "@/hooks/useImport";
import { SalesOrderPeekSheet } from "@/features/sales/orders/SalesOrderPeekSheet";
import { usePeekParam } from "@/design-system/records";
import { SalesOrderListTable } from "@/components/sales/SalesOrderListTable";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SummaryStatCard, SummaryStatGrid } from "@/components/common/SummaryStatCards";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, Search, MoreHorizontal, FileText, Truck, Loader2, ShoppingCart, Upload, Printer, Eye, CheckCircle, Ban, ArrowRight, CalendarDays, Package, TrendingUp, Filter, Mail } from "lucide-react";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { format } from "date-fns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { toast } from "sonner";
import { useToast } from "@/hooks/use-toast";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { fetchAndBuildSalesOrderSnapshot } from "@/services/documents/snapshots/salesOrder";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "processing", label: "Processing" },
  { value: "partial", label: "Partial" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "invoiced", label: "Invoiced" },
  { value: "cancelled", label: "Cancelled" },
];

const DATE_RANGE_OPTIONS = [
  { value: "all", label: "All Time" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "last_3_months", label: "Last 3 Months" },
  { value: "custom", label: "Custom Range" },
];

export default function SalesOrders() {
  const { deleteSalesOrder, confirmSalesOrder, cancelSalesOrder, createDeliveryNote, convertToInvoice, createSalesOrder } = useSalesOrders();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { exportSalesOrders } = useExport();
  const { toast: shadcnToast } = useToast();
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState("");
  const [printDocumentId, setPrintDocumentId] = useState("");
  const [printCommunication, setPrintCommunication] =
    useState<Parameters<typeof PrintPreviewDialog>[0]["communication"]>(undefined);
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const handlePrint = useCallback(async (order: { id: string; so_number: string }) => {
    if (!currentBusiness?.id) {
      shadcnToast({
        title: "No company selected",
        description: "Pick a company before printing sales orders.",
        variant: "destructive",
      });
      return;
    }
    if (!currentOrg?.id) {
      shadcnToast({
        title: "No organization",
        description: "Sign in to an organization before printing.",
        variant: "destructive",
      });
      return;
    }
    try {
      const built = await fetchAndBuildSalesOrderSnapshot(supabase, order.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.order_ack",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "sales_order",
        sourceDocId: order.id,
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
        shadcnToast,
        { label: `Sales order ${order.so_number}` },
      );
    } catch (err) {
      shadcnToast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  }, [currentBusiness?.id, currentOrg?.id, shadcnToast]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateRange, setDateRange] = useState("all");
  const [customDateFrom, setCustomDateFrom] = useState("");
  const [customDateTo, setCustomDateTo] = useState("");
  const {
    data: salesOrders,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    refetch,
  } = usePaginatedListQuery<SalesOrder>({
    cacheKey: "sales_orders",
    table: "sales_orders",
    select: "*, contact:contacts!sales_orders_contact_id_fkey(name, email)",
    search: searchQuery || undefined,
    searchColumns: ["so_number"],
    status: statusFilter,
    dateColumn: "order_date",
    dateRange: dateRange === "custom" ? undefined : dateRange,
    extra: (q) => {
      if (dateRange === "custom" && customDateFrom && customDateTo) {
        q = q.gte("order_date", customDateFrom).lte("order_date", customDateTo);
      }
      return q;
    },
  });
  const navigate = useNavigate();
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [detailOrderId, setDetailOrderId] = usePeekParam();
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  
  // Contact preview drawer
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  
  // Email dialog
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  
  // Linked documents + fulfillment cache
  const [linkedDocs, setLinkedDocs] = useState<Record<string, { invoiceNumber?: string; deliveryCount?: number; fulfillmentPercent?: number }>>({});
  
  const contactResolverRef = useRef<ContactResolver | null>(null);
  const productResolverRef = useRef<ProductResolver | null>(null);

  // Load linked documents and fulfillment data for visible orders
  useEffect(() => {
    if (salesOrders.length === 0) return;
    const loadLinkedDocs = async () => {
      const orderIds = salesOrders.map(o => o.id);
      
      // Get invoices linked to these SOs
      const invoiceMap: Record<string, string> = {};
      const soWithInvoices = salesOrders.filter(o => o.converted_invoice_id);
      if (soWithInvoices.length > 0) {
        const { data: invoices } = await supabase
          .from("invoices")
          .select("id, invoice_number")
          .in("id", soWithInvoices.map(o => o.converted_invoice_id!));
        invoices?.forEach(inv => { invoiceMap[inv.id] = inv.invoice_number; });
      }
      
      // Get delivery note counts per SO
      const { data: dnCounts } = await supabase
        .from("delivery_notes")
        .select("sales_order_id")
        .in("sales_order_id", orderIds);
      
      const countMap: Record<string, number> = {};
      dnCounts?.forEach(dn => {
        countMap[dn.sales_order_id!] = (countMap[dn.sales_order_id!] || 0) + 1;
      });

      // Fulfilment progress comes from the canonical ledger view, which nets
      // off cancelled quantity. Re-summing sales_order_items here reported an
      // order as under-delivered forever once part of it was cancelled.
      const { data: soItems } = await supabase
        .from("so_line_balances" as any)
        .select("sales_order_id, quantity_ordered, quantity_delivered, quantity_cancelled")
        .in("sales_order_id", orderIds);

      const fulfillmentMap: Record<string, { total: number; fulfilled: number }> = {};
      (soItems as unknown as Array<{
        sales_order_id: string;
        quantity_ordered: number | null;
        quantity_delivered: number | null;
        quantity_cancelled: number | null;
      }> | null)?.forEach(item => {
        if (!fulfillmentMap[item.sales_order_id]) fulfillmentMap[item.sales_order_id] = { total: 0, fulfilled: 0 };
        fulfillmentMap[item.sales_order_id].total +=
          Math.max((item.quantity_ordered || 0) - (item.quantity_cancelled || 0), 0);
        fulfillmentMap[item.sales_order_id].fulfilled += item.quantity_delivered || 0;
      });

      
      const docs: Record<string, { invoiceNumber?: string; deliveryCount?: number; fulfillmentPercent?: number }> = {};
      salesOrders.forEach(o => {
        const f = fulfillmentMap[o.id];
        docs[o.id] = {
          invoiceNumber: o.converted_invoice_id ? invoiceMap[o.converted_invoice_id] : undefined,
          deliveryCount: countMap[o.id] || 0,
          fulfillmentPercent: f && f.total > 0 ? Math.round((f.fulfilled / f.total) * 100) : 0,
        };
      });
      setLinkedDocs(docs);
    };
    loadLinkedDocs();
  }, [salesOrders]);

  const soFieldDefinitions = SALES_ORDER_IMPORT_FIELDS;

  const handleBatchImportSO: BatchImportFn = useCallback(async (rows) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected. Pick a company before importing.");

    if (!contactResolverRef.current) {
      contactResolverRef.current = new ContactResolver(currentOrg.id, currentBusiness.id, "customer", contacts);
    }
    if (!productResolverRef.current) {
      productResolverRef.current = new ProductResolver(currentOrg.id, currentBusiness.id, products);
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

        const items = groupRows.map((row) => {
          const quantity = Number(row.quantity) || 1;
          const unitPrice = Number(row.unit_price) || 0;
          const taxRate = Number(row.tax_rate) || 0;
          const discountPercent = Number(row.discount_percent) || 0;
          const subtotal = quantity * unitPrice;
          const discount = subtotal * (discountPercent / 100);
          const afterDiscount = subtotal - discount;
          const taxAmount = afterDiscount * (taxRate / 100);

          return {
            description: row.item_description,
            quantity,
            unit_price: unitPrice,
            tax_rate: taxRate,
            tax_amount: taxAmount,
            discount_percent: discountPercent,
            line_total: afterDiscount,
          };
        });

        await createSalesOrder(
          {
            contact_id: resolved.id,
            order_date: firstRow.order_date || new Date().toISOString().split("T")[0],
            expected_date: firstRow.expected_date || null,
            notes: firstRow.notes || null,
            currency: baseCurrency,
            status: "draft",
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
  }, [currentOrg, contacts, products, baseCurrency, createSalesOrder]);

  const handleImportComplete = () => {
    contactResolverRef.current = null;
    productResolverRef.current = null;
  };

  // Handle ?action=create and ?edit= URL parameters
  useEffect(() => {
    if (searchParams.get("action") === "create") {
      const prefillContactId = searchParams.get("contact_id");
      const qs = new URLSearchParams();
      if (prefillContactId) qs.set("contact_id", prefillContactId);
      navigate(`/sales/orders/new${qs.toString() ? `?${qs}` : ""}`);
      return;
    }
    const editId = searchParams.get("edit") || searchParams.get("id");
    if (!editId || isLoading) return;

    const orderToEdit = salesOrders.find((o) => o.id === editId);
    if (orderToEdit) {
      setDetailOrderId(editId);
      const next = new URLSearchParams(searchParams);
      next.delete("edit");
      next.delete("id");
      setSearchParams(next, { replace: true });
    } else if (salesOrders.length > 0) {
      // Not in local array — fetch directly
      supabase
        .from("sales_orders")
        .select("*, contact:contacts!sales_orders_contact_id_fkey(name, email)")
        .eq("id", editId)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setDetailOrderId(editId);
          }
          const next = new URLSearchParams(searchParams);
          next.delete("edit");
          next.delete("id");
          setSearchParams(next, { replace: true });
        });
    }
  }, [salesOrders, searchParams, isLoading, setSearchParams]);

  // Server-side filtering + pagination via usePaginatedListQuery above
  const filteredOrders = salesOrders;

  const bulkSelection = useBulkSelection({
    items: filteredOrders,
    getItemId: (order) => order.id,
  });

  const handleBulkDelete = async () => {
    setIsBulkDeleting(true);
    try {
      const selectedItems = bulkSelection.selectedItems;
      let successCount = 0;
      let errorCount = 0;

      for (const item of selectedItems) {
        try {
          await deleteSalesOrder(item.id);
          successCount++;
        } catch {
          errorCount++;
        }
      }

      if (successCount > 0) {
        shadcnToast({
          title: `${successCount} order${successCount > 1 ? "s" : ""} deleted`,
          description: errorCount > 0 ? `${errorCount} failed to delete` : undefined,
        });
      }
      
      bulkSelection.clearSelection();
    } catch (error: any) {
      shadcnToast({
        title: "Error deleting orders",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsBulkDeleting(false);
      setShowBulkDeleteDialog(false);
    }
  };

  const handleBulkExport = () => {
    const selectedItems = bulkSelection.selectedItems;
    exportSalesOrders(selectedItems);
    shadcnToast({
      title: `Exported ${selectedItems.length} order${selectedItems.length > 1 ? "s" : ""}`,
    });
    bulkSelection.clearSelection();
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      draft: "bg-muted text-muted-foreground",
      confirmed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      processing: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      partial: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
      fulfilled: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      invoiced: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    };
    return <Badge className={styles[status] || "bg-muted"}>{status}</Badge>;
  };

  // Stats computed from ALL orders (not filtered)
  const stats = useMemo(() => {
    const byStatus: Record<string, { count: number; value: number }> = {};
    salesOrders.forEach(o => {
      if (!byStatus[o.status]) byStatus[o.status] = { count: 0, value: 0 };
      byStatus[o.status].count++;
      byStatus[o.status].value += o.total || 0;
    });
    const totalValue = salesOrders.reduce((s, o) => s + (o.total || 0), 0);
    const activeValue = salesOrders
      .filter(o => !["cancelled", "draft"].includes(o.status))
      .reduce((s, o) => s + (o.total || 0), 0);

    return {
      total: salesOrders.length,
      totalValue,
      activeValue,
      draft: byStatus.draft?.count || 0,
      draftValue: byStatus.draft?.value || 0,
      confirmed: byStatus.confirmed?.count || 0,
      confirmedValue: byStatus.confirmed?.value || 0,
      processing: (byStatus.processing?.count || 0) + (byStatus.partial?.count || 0),
      processingValue: (byStatus.processing?.value || 0) + (byStatus.partial?.value || 0),
      fulfilled: (byStatus.fulfilled?.count || 0) + (byStatus.invoiced?.count || 0),
      fulfilledValue: (byStatus.fulfilled?.value || 0) + (byStatus.invoiced?.value || 0),
    };
  }, [salesOrders]);

  // Pipeline summary counts
  const pipeline = useMemo(() => {
    const counts: Record<string, number> = {};
    salesOrders.forEach(o => {
      counts[o.status] = (counts[o.status] || 0) + 1;
    });
    return counts;
  }, [salesOrders]);

  const pipelineSteps = [
    { key: "draft", label: "Draft", color: "bg-muted" },
    { key: "confirmed", label: "Confirmed", color: "bg-blue-500" },
    { key: "processing", label: "Processing", color: "bg-amber-500" },
    { key: "partial", label: "Partial", color: "bg-orange-500" },
    { key: "fulfilled", label: "Fulfilled", color: "bg-green-500" },
    { key: "invoiced", label: "Invoiced", color: "bg-purple-500" },
  ];

  const hasActiveFilters = statusFilter !== "all" || dateRange !== "all" || searchQuery.length > 0;

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">Sales Orders</h1>
              {currentOrg && (
                <RefreshButton queryKeyPrefixes={[queryKeys.salesOrders.all(currentOrg.id)]} tooltip="Refresh sales orders" />
              )}
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">Manage customer orders and fulfillment</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="sales_order" />
            <StudioQuickPanelTrigger entityType="sales_order" />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "so_number", header: "SO #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 25 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
                ];
                const rows = filteredOrders.map((o) => ({
                  so_number: o.so_number,
                  date: o.order_date,
                  customer: o.contact?.name || "",
                  status: o.status,
                  total: o.total,
                }));
                return {
                  title: "Sales Orders Report",
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="manageSales">
              <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                <Upload className="mr-2 h-4 w-4" /> Import
              </Button>
              <ScanToDocumentButton createPath="/sales/orders/new" label="Scan to order" />
              <Button onClick={() => navigate("/sales/orders/new")} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                New Sales Order
              </Button>
            </PermissionGate>
          </div>
        </div>



        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Sales Order"
          fieldDefinitions={soFieldDefinitions}
          onImport={async () => {}}
          onBatchImport={handleBatchImportSO}
          onComplete={handleImportComplete}
        />

        {/* Pipeline Summary Strip */}
        {salesOrders.length > 0 && (
          <Card>
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-1 overflow-x-auto">
                {pipelineSteps.map((step, i) => {
                  const count = pipeline[step.key] || 0;
                  if (count === 0 && !["draft", "confirmed", "fulfilled"].includes(step.key)) return null;
                  return (
                    <button
                      key={step.key}
                      onClick={() => setStatusFilter(statusFilter === step.key ? "all" : step.key)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                        statusFilter === step.key 
                          ? "bg-primary text-primary-foreground" 
                          : "hover:bg-muted"
                      }`}
                    >
                      <span className={`h-2 w-2 rounded-full ${step.color}`} />
                      {step.label}
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                        statusFilter === step.key ? "bg-primary-foreground/20" : "bg-muted"
                      }`}>
                        {count}
                      </span>
                      {i < pipelineSteps.length - 1 && count > 0 && (
                        <ArrowRight className="h-3 w-3 text-muted-foreground ml-1" />
                      )}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats */}
        <SummaryStatGrid>
          <SummaryStatCard
            icon={<ShoppingCart className="h-3.5 w-3.5" />}
            label="Total Orders"
            tone="primary"
            value={stats.total}
            footer={formatCurrency(stats.totalValue)}
          />
          <SummaryStatCard
            accent
            tone="blue"
            icon={<CheckCircle className="h-3.5 w-3.5" />}
            label="Confirmed"
            value={stats.confirmed}
            footer={`${formatCurrency(stats.confirmedValue)} ready`}
          />
          <SummaryStatCard
            accent
            tone="amber"
            icon={<Package className="h-3.5 w-3.5" />}
            label="In Progress"
            value={stats.processing}
            footer={`${formatCurrency(stats.processingValue)} being fulfilled`}
          />
          <SummaryStatCard
            accent
            tone="emerald"
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="Completed"
            value={stats.fulfilled}
            footer={`${formatCurrency(stats.fulfilledValue)} fulfilled`}
          />
        </SummaryStatGrid>

        {/* Filters Bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by order number or customer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full"
            />
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue placeholder="All Time" />
              </SelectTrigger>
              <SelectContent>
                {DATE_RANGE_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={() => { setStatusFilter("all"); setDateRange("all"); setSearchQuery(""); }}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Custom date range inputs */}
        {dateRange === "custom" && (
          <div className="flex items-center gap-2">
            <Input type="date" value={customDateFrom} onChange={e => setCustomDateFrom(e.target.value)} className="w-40" />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="date" value={customDateTo} onChange={e => setCustomDateTo(e.target.value)} className="w-40" />
          </div>
        )}

        {/* Results count */}
        {hasActiveFilters && (
          <p className="text-sm text-muted-foreground">
            Showing {filteredOrders.length} of {salesOrders.length} orders
          </p>
        )}

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <ShoppingCart className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">
                  {hasActiveFilters ? "No matching orders" : "No sales orders yet"}
                </h3>
                <p className="text-muted-foreground mb-4">
                  {hasActiveFilters 
                    ? "Try adjusting your filters" 
                    : "Create your first sales order to get started"}
                </p>
                {!hasActiveFilters && (
                  <PermissionGate permission="manageSales">
                    <Button onClick={() => navigate("/sales/orders/new")}>
                      <Plus className="mr-2 h-4 w-4" />
                      New Sales Order
                    </Button>
                  </PermissionGate>
                )}
              </div>
            ) : (
              <SalesOrderListTable
                orders={filteredOrders}
                isLoading={isLoading}
                linkedDocs={linkedDocs}
                bulkSelection={bulkSelection}
                isReadOnly={isReadOnly}
                onViewDetail={setDetailOrderId}
                onEdit={(order) => {
                  if (isReadOnly) { openUpgradeModal("sales_orders"); return; }
                  navigate(`/sales/orders/${order.id}/edit`);
                }}
                onConfirm={async (order) => {
                  if (isReadOnly) { openUpgradeModal("sales_orders"); return; }
                  // Confirmation is DB-owned: `confirm_sales_order_atomic`
                  // flips the status AND creates the stock reservations.
                  await confirmSalesOrder(order.id);
                }}
                onCreateDeliveryNote={async (order) => {
                  if (isReadOnly) { openUpgradeModal("sales_orders"); return; }
                  await createDeliveryNote(order.id);
                }}
                onConvertToInvoice={async (order) => {
                  if (isReadOnly) { openUpgradeModal("sales_orders"); return; }
                  await convertToInvoice(order.id);
                }}
                onCancel={async (order) => {
                  if (isReadOnly) { openUpgradeModal("sales_orders"); return; }
                  // Cancellation is compensation, not a status overwrite.
                  await cancelSalesOrder(order.id);
                }}

                onDelete={(order) => {
                  if (isReadOnly) { openUpgradeModal("sales_orders"); return; }
                  deleteSalesOrder(order.id);
                }}
                onPrint={(order) => { void handlePrint(order); }}
                onSendEmail={(order) => {
                  const contact = contacts.find(c => c.id === order.contact_id);
                  setEmailDocument({
                    documentType: "sales_order",
                    documentId: order.id,
                    documentNumber: order.so_number,
                    recipientEmail: contact?.email || "",
                    recipientName: order.contact?.name || "",
                    total: order.total,
                    currency: order.currency || "",
                  });
                  setShowEmailDialog(true);
                }}
                onPreviewContact={setPreviewContactId}
              />
            )}
            <DataTablePagination
              pagination={pagination}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              isLoading={isFetching}
            />
          </CardContent>
        </Card>

        {/* Detail Dialog */}
        <SalesOrderPeekSheet
          salesOrderId={detailOrderId}
          onOpenChange={(open) => { if (!open) setDetailOrderId(null); }}
        />




        <PrintPreviewDialog
          open={printPreviewOpen}
          onOpenChange={setPrintPreviewOpen}
          title={printPreviewTitle}
          documentType={printDocumentType}
          documentId={printDocumentId}
          communication={printCommunication}
        />

        <BulkDeleteDialog
          open={showBulkDeleteDialog}
          onOpenChange={setShowBulkDeleteDialog}
          count={bulkSelection.selectedCount}
          entityName={bulkSelection.selectedCount === 1 ? "order" : "orders"}
          onConfirm={handleBulkDelete}
          isDeleting={isBulkDeleting}
        />

        <BulkActionsToolbar
          selectedCount={bulkSelection.selectedCount}
          onDelete={!isReadOnly ? () => setShowBulkDeleteDialog(true) : undefined}
          onExport={handleBulkExport}
          onClearSelection={bulkSelection.clearSelection}
          isDeleting={isBulkDeleting}
          entityName={bulkSelection.selectedCount === 1 ? "order" : "orders"}
        />


        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
        />

        <ContactPreviewDrawer
          open={!!previewContactId}
          onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
          contactId={previewContactId || undefined}
        />
      </div>
    </>
  );
}
