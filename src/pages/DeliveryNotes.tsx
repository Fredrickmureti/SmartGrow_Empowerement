import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useDeliveryNotes } from "@/hooks/useDeliveryNotes";
import { useDeliveryNotesPaginated } from "@/hooks/useDeliveryNotesPaginated";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useViewMode } from "@/hooks/useViewMode";
import { queryKeys } from "@/lib/queryKeys";
import { useExport } from "@/hooks/useExport";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { BulkActionsToolbar } from "@/components/common/BulkActionsToolbar";
import { BulkDeleteDialog } from "@/components/common/BulkDeleteDialog";

import { DeliveryNotePeekSheet } from "@/features/sales/delivery-notes/DeliveryNotePeekSheet";
import { usePeekParam } from "@/design-system/records";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
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
import { Plus, Search, MoreHorizontal, FileText, CheckCircle, Loader2, Truck, Mail, Printer, Eye, Package, ArrowRight, Navigation, ExternalLink } from "lucide-react";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { format } from "date-fns";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePrintDeliveryNote } from "@/features/sales/delivery-notes/usePrintDeliveryNote";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useMarkDeliveryReady, useCompleteDelivery } from "@/hooks/useDeliveryLifecycle";
import { normalizeError } from "@/services/resilience";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending" },
  { value: "ready_to_dispatch", label: "Ready to dispatch" },
  { value: "dispatched", label: "Dispatched" },
  { value: "in_transit", label: "In Transit" },
  { value: "delivered", label: "Delivered" },
  { value: "partial", label: "Partial" },
  { value: "cancelled", label: "Cancelled" },
];

const DATE_RANGE_OPTIONS = [
  { value: "all", label: "All Time" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "last_3_months", label: "Last 3 Months" },
];

export default function DeliveryNotes() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { deleteDeliveryNote, cancelDelivery } = useDeliveryNotes();
  const markReady = useMarkDeliveryReady(null);
  const completeDelivery = useCompleteDelivery(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateRange, setDateRange] = useState("all");
  const {
    deliveryNotes,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    refetch,
    stats,
  } = useDeliveryNotesPaginated({
    search: searchQuery || undefined,
    status: statusFilter,
    dateRange,
  });
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { exportDeliveryNotes } = useExport();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  // Wave 7.2 — print goes straight down the canonical document pipeline
  // (snapshot → document_records → output intent). The preview dialog is
  // kept as an operator-facing fallback surface only; it is no longer the
  // print path.
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState("");
  const [printDocumentId, setPrintDocumentId] = useState("");
  const [printCommunication, setPrintCommunication] =
    useState<Parameters<typeof PrintPreviewDialog>[0]["communication"]>(undefined);

  // Print runs through the shared delivery-note print event (snapshot →
  // document_records → output intent), identical to the record page.
  const handlePrint = usePrintDeliveryNote();

  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "delivery_note" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters } = useCustomFieldFiltering("delivery_note");
  
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [detailDnId, setDetailDnId] = usePeekParam();
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const navigate = useNavigate();

  // Handle ?id= or ?edit= URL parameter for cross-document navigation
  useEffect(() => {
    const deepLinkId = searchParams.get("id") || searchParams.get("edit");
    if (!deepLinkId || isLoading) return;

    const dn = deliveryNotes.find((n) => n.id === deepLinkId);
    if (dn) {
      setDetailDnId(deepLinkId);
      const next = new URLSearchParams(searchParams);
      next.delete("id");
      next.delete("edit");
      setSearchParams(next, { replace: true });
    } else if (deliveryNotes.length > 0) {
      // Not in local array — fetch directly
      supabase
        .from("delivery_notes")
        .select("*, contact:contacts!contact_id(name, email), sales_order:sales_orders(so_number)")
        .eq("id", deepLinkId)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setDetailDnId(deepLinkId);
          }
          const next = new URLSearchParams(searchParams);
          next.delete("id");
          next.delete("edit");
          setSearchParams(next, { replace: true });
        });
    }
  }, [deliveryNotes, searchParams, isLoading, setSearchParams]);

  // Load item counts + linked invoice for each delivery note
  const [enrichedData, setEnrichedData] = useState<Record<string, { items: number; delivered: number; invoiceNumber?: string }>>({});
  useEffect(() => {
    if (deliveryNotes.length === 0) return;
    const loadData = async () => {
      // Item counts
      const { data: items } = await supabase
        .from("delivery_note_items")
        .select("delivery_note_id, quantity_ordered, quantity_delivered")
        .in("delivery_note_id", deliveryNotes.map(n => n.id));
      
      const counts: Record<string, { items: number; delivered: number }> = {};
      items?.forEach(item => {
        if (!counts[item.delivery_note_id]) counts[item.delivery_note_id] = { items: 0, delivered: 0 };
        counts[item.delivery_note_id].items += item.quantity_ordered;
        counts[item.delivery_note_id].delivered += item.quantity_delivered;
      });

      // Get linked invoices via sales orders
      const soIds = [...new Set(deliveryNotes.map(n => n.sales_order_id).filter(Boolean))];
      const invoiceMap: Record<string, string> = {};
      if (soIds.length > 0) {
        const { data: sos } = await supabase
          .from("sales_orders")
          .select("id, converted_invoice_id")
          .in("id", soIds)
          .not("converted_invoice_id", "is", null);
        
        if (sos && sos.length > 0) {
          const invIds = sos.map(so => so.converted_invoice_id!);
          const { data: invoices } = await supabase
            .from("invoices")
            .select("id, invoice_number")
            .in("id", invIds);
          
          const invNumMap: Record<string, string> = {};
          invoices?.forEach(inv => { invNumMap[inv.id] = inv.invoice_number; });
          sos.forEach(so => {
            if (so.converted_invoice_id && invNumMap[so.converted_invoice_id]) {
              invoiceMap[so.id] = invNumMap[so.converted_invoice_id];
            }
          });
        }
      }

      const enriched: Record<string, { items: number; delivered: number; invoiceNumber?: string }> = {};
      deliveryNotes.forEach(n => {
        const c = counts[n.id] || { items: 0, delivered: 0 };
        enriched[n.id] = {
          ...c,
          invoiceNumber: n.sales_order_id ? invoiceMap[n.sales_order_id] : undefined,
        };
      });
      setEnrichedData(enriched);
    };
    loadData();
  }, [deliveryNotes]);

  // filtering + pagination happens server-side in useDeliveryNotesPaginated
  const filteredNotes = deliveryNotes;

  const bulkSelection = useBulkSelection({
    items: filteredNotes,
    getItemId: (note) => note.id,
  });

  const handleBulkDelete = async () => {
    setIsBulkDeleting(true);
    try {
      const selectedItems = bulkSelection.selectedItems;
      let successCount = 0;
      let errorCount = 0;

      for (const item of selectedItems) {
        try {
          await deleteDeliveryNote(item.id);
          successCount++;
        } catch {
          errorCount++;
        }
      }

      if (successCount > 0) {
        toast({
          title: `${successCount} note${successCount > 1 ? "s" : ""} deleted`,
          description: errorCount > 0 ? `${errorCount} failed to delete` : undefined,
        });
      }
      
      bulkSelection.clearSelection();
    } catch (error: any) {
      toast({
        title: "Error deleting notes",
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
    exportDeliveryNotes(selectedItems);
    toast({
      title: `Exported ${selectedItems.length} note${selectedItems.length > 1 ? "s" : ""}`,
    });
    bulkSelection.clearSelection();
  };

  const handleSendEmail = (note: typeof deliveryNotes[0]) => {
    setEmailDocument({
      documentType: "delivery_note",
      documentId: note.id,
      documentNumber: note.delivery_number,
      recipientEmail: note.contact?.email || "",
      recipientName: note.contact?.name || "",
    });
    setShowEmailDialog(true);
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      ready_to_dispatch: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
      dispatched: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
      in_transit: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      delivered: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      partial: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
      cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    };
    return <Badge className={styles[status] || "bg-muted"}>{status.replace("_", " ")}</Badge>;
  };

  // stats are returned by useDeliveryNotesPaginated above

  const hasActiveFilters = statusFilter !== "all" || dateRange !== "all" || searchQuery.length > 0;

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">Delivery Notes</h1>
              {currentOrg && (
                <RefreshButton
                  queryKeyPrefixes={[queryKeys.deliveryNotes.all(currentOrg.id)]}
                  tooltip="Refresh delivery notes"
                />
              )}
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">Track shipments and deliveries</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "dn_number", header: "DN #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 25 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "so_number", header: "Sales Order", width: 15 },
                ];
                const rows = filteredNotes.map((n) => ({
                  dn_number: n.delivery_number,
                  date: n.delivery_date,
                  customer: n.contact?.name || "",
                  status: n.status,
                  so_number: n.sales_order?.so_number || "",
                }));
                return {
                  title: "Delivery Notes Report",
                  columns: cols,
                  rows,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="manageSales">
              <ScanToDocumentButton createPath="/sales/delivery-notes/new" label="Scan to delivery note" />
              <Button onClick={() => navigate("/sales/delivery-notes/new")} className="w-full sm:w-auto shrink-0">
                <Plus className="mr-2 h-4 w-4" />
                New Delivery Note
              </Button>
            </PermissionGate>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5" />
                Total Deliveries
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Truck className="h-3.5 w-3.5" />
                Pending
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">{stats.pending}</div>
              <p className="text-xs text-muted-foreground mt-1">Awaiting dispatch</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Navigation className="h-3.5 w-3.5" />
                In Transit
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{stats.inTransit}</div>
              <p className="text-xs text-muted-foreground mt-1">On the way</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5" />
                Delivered
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.delivered}</div>
              <p className="text-xs text-muted-foreground mt-1">Completed</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by delivery #, customer, or sales order..."
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

        {hasActiveFilters && (
          <p className="text-sm text-muted-foreground">
            Showing {filteredNotes.length} of {deliveryNotes.length} delivery notes
          </p>
        )}

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredNotes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <Truck className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">{hasActiveFilters ? "No matching delivery notes" : "No delivery notes yet"}</h3>
                <p className="text-muted-foreground mb-4">{hasActiveFilters ? "Try adjusting your filters" : "Create a delivery note from a sales order"}</p>
                {!hasActiveFilters && (
                  <PermissionGate permission="manageSales">
                    <Button onClick={() => navigate("/sales/delivery-notes/new")}>
                      <Plus className="mr-2 h-4 w-4" />
                      New Delivery Note
                    </Button>
                  </PermissionGate>
                )}
              </div>
            ) : (
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={bulkSelection.isAllSelected}
                        onCheckedChange={bulkSelection.toggleAll}
                        aria-label="Select all"
                        className={bulkSelection.isPartiallySelected ? "data-[state=checked]:bg-primary/50" : ""}
                      />
                    </TableHead>
                    <TableHead>Delivery #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Sales Order</TableHead>
                    <TableHead>Fulfillment</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredNotes.map((note) => {
                    const data = enrichedData[note.id];
                    const fulfillPct = data && data.items > 0 ? Math.round((data.delivered / data.items) * 100) : 0;
                    return (
                    <TableRow
                      key={note.id}
                      data-state={bulkSelection.isSelected(note.id) ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={() => setDetailDnId(note.id)}
                    >
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Checkbox
                          checked={bulkSelection.isSelected(note.id)}
                          onCheckedChange={() => bulkSelection.toggleItem(note.id)}
                          aria-label={`Select delivery note ${note.delivery_number}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium text-primary">
                        {note.delivery_number}
                        {(note as any).is_backorder && (
                          <Badge variant="outline" className="ml-2 text-[10px]">Backorder</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-medium" onClick={(e) => e.stopPropagation()}>
                        {note.contact_id && note.contact?.name ? (
                          <ClickableEntity onClick={() => setPreviewContactId(note.contact_id)}>
                            {note.contact.name}
                          </ClickableEntity>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{format(new Date(note.delivery_date), "MMM d, yyyy")}</TableCell>
                      <TableCell>
                        {note.sales_order?.so_number ? (
                          <Badge variant="outline" className="text-xs font-normal gap-1">
                            <FileText className="h-3 w-3" />
                            {note.sales_order.so_number}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {data && data.items > 0 ? (
                          <div className="flex items-center gap-2 min-w-[90px]">
                            <Progress value={fulfillPct} className="h-2 flex-1" />
                            <span className="text-xs text-muted-foreground w-14 text-right">
                              {data.delivered}/{data.items}
                            </span>
                          </div>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {data?.invoiceNumber ? (
                          <Badge variant="outline" className="text-xs font-normal gap-1">
                            <FileText className="h-3 w-3" />
                            {data.invoiceNumber}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(note.status)}</TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setDetailDnId(note.id)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/sales/delivery-notes/${note.id}`)}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              Open Full Page
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handlePrint(note)}>
                              <Printer className="mr-2 h-4 w-4" />
                              Print
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleSendEmail(note)}>
                              <Mail className="mr-2 h-4 w-4" />
                              Send via Email
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {note.status === "pending" && (
                              <DropdownMenuItem onClick={() => {
                                if (isReadOnly) { openUpgradeModal("delivery_notes"); return; }
                                markReady.mutate(note.id);
                              }}>
                                <Navigation className="mr-2 h-4 w-4" />
                                Mark Ready to Dispatch
                              </DropdownMenuItem>
                            )}
                            {(note.status === "pending" || note.status === "ready_to_dispatch") && (
                              <DropdownMenuItem onClick={() => {
                                if (isReadOnly) { openUpgradeModal("delivery_notes"); return; }
                                setDetailDnId(note.id);
                              }}>
                                <Truck className="mr-2 h-4 w-4" />
                                Dispatch…
                              </DropdownMenuItem>
                            )}
                            {note.status !== "delivered" && note.status !== "partial" && note.status !== "cancelled" && (
                              <DropdownMenuItem onClick={() => {
                                if (isReadOnly) { openUpgradeModal("delivery_notes"); return; }
                                completeDelivery.mutate({ id: note.id });
                              }}>
                                <CheckCircle className="mr-2 h-4 w-4" />
                                Complete Delivery
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem 
                              className="text-destructive"
                              onClick={() => {
                                if (isReadOnly) { openUpgradeModal("delivery_notes"); return; }
                                deleteDeliveryNote(note.id);
                              }}
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
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
        <DeliveryNotePeekSheet
          deliveryNoteId={detailDnId}
          onOpenChange={(open) => { if (!open) setDetailDnId(null); }}
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
          communication={printCommunication}
        />

        <BulkDeleteDialog
          open={showBulkDeleteDialog}
          onOpenChange={setShowBulkDeleteDialog}
          count={bulkSelection.selectedCount}
          entityName={bulkSelection.selectedCount === 1 ? "delivery note" : "delivery notes"}
          onConfirm={handleBulkDelete}
          isDeleting={isBulkDeleting}
        />

        <BulkActionsToolbar
          selectedCount={bulkSelection.selectedCount}
          onDelete={!isReadOnly ? () => setShowBulkDeleteDialog(true) : undefined}
          onExport={handleBulkExport}
          onClearSelection={bulkSelection.clearSelection}
          isDeleting={isBulkDeleting}
          entityName={bulkSelection.selectedCount === 1 ? "delivery note" : "delivery notes"}
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
