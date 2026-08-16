import { useState, useMemo } from "react";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useVendorPriceLists } from "@/hooks/useVendorPriceLists";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, MoreHorizontal, Trash2, Star, Edit, ListChecks, AlertTriangle, Clock, Eye, ShieldCheck } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { VendorPriceListPeekSheet } from "@/features/purchases/price-lists/VendorPriceListPeekSheet";
import {
  VendorPriceListFormSheet,
  type VendorPriceListFormValues,
} from "@/features/purchases/price-lists/VendorPriceListFormSheet";

export default function VendorPriceLists() {
  const { priceLists, isLoading, createPriceList, updatePriceList, deletePriceList } = useVendorPriceLists();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency } = useCurrency();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<Partial<VendorPriceListFormValues> | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState("all");
  const [validityFilter, setValidityFilter] = useState("all");
  const [viewingEntry, setViewingEntry] = useState<any | null>(null);

  const vendors = contacts.filter((c) => (c.type === "supplier" || c.type === "both") && c.is_active);

  const handleOpenCreate = () => {
    setSheetMode("create");
    setEditingId(null);
    setInitialValues(undefined);
    setSheetOpen(true);
  };

  const handleOpenEdit = (entry: any) => {
    setSheetMode("edit");
    setEditingId(entry.id);
    setInitialValues({
      vendor_id: entry.vendor_id,
      product_id: entry.product_id,
      unit_price: entry.unit_price,
      currency: entry.currency,
      min_order_qty: entry.min_order_qty,
      order_increment: entry.order_increment ?? 0,
      price_break_tiers: entry.price_break_tiers ?? [],
      lead_time_days: entry.lead_time_days,
      is_preferred: entry.is_preferred,
      valid_from: entry.valid_from || "",
      valid_until: entry.valid_until || "",
      notes: entry.notes || "",
      is_active: entry.is_active,
    });
    setSheetOpen(true);
  };

  const handleSubmit = async (values: VendorPriceListFormValues) => {
    const payload = {
      ...values,
      valid_from: values.valid_from || null,
      valid_until: values.valid_until || null,
      notes: values.notes || null,
      order_increment: values.order_increment > 0 ? values.order_increment : null,
      price_break_tiers: [...values.price_break_tiers].sort(
        (a, b) => a.min_qty - b.min_qty,
      ),
    };
    if (editingId) {
      await updatePriceList({ id: editingId, ...payload });
    } else {
      await createPriceList(payload);
    }

    setSheetOpen(false);
    setEditingId(null);
    setInitialValues(undefined);
  };

  // Lifecycle state is server-derived (`effective_status`, ADR 0142 Phase 3).
  // The browser must not recompute validity windows.
  const isExpired = (entry: any) => entry.effective_status === "expired";
  const isExpiringSoon = (entry: any) => entry.effective_status === "expiring_soon";

  const STATUS_LABEL: Record<string, string> = {
    active: "Active",
    expiring_soon: "Expiring",
    expired: "Expired",
    scheduled: "Scheduled",
    inactive: "Inactive",
    draft: "Draft",
    pending_approval: "Pending approval",
    rejected: "Rejected",
  };

  const filteredList = priceLists.filter((entry) => {
    const matchesSearch =
      entry.vendor?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.product?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.product?.sku?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesVendor = vendorFilter === "all" || entry.vendor_id === vendorFilter;
    let matchesValidity = true;
    if (validityFilter === "active") matchesValidity = entry.effective_status === "active";
    else if (validityFilter === "expiring") matchesValidity = entry.effective_status === "expiring_soon";
    else if (validityFilter === "expired") matchesValidity = entry.effective_status === "expired";
    else if (validityFilter === "scheduled") matchesValidity = entry.effective_status === "scheduled";
    else if (validityFilter === "pending")
      matchesValidity =
        entry.effective_status === "pending_approval" || entry.effective_status === "draft";
    else if (validityFilter === "preferred") matchesValidity = entry.is_preferred;
    return matchesSearch && matchesVendor && matchesValidity;
  });

  const getExportConfig = (): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "supplier", header: "Supplier", width: 20 },
      { key: "product", header: "Product", width: 20 },
      { key: "sku", header: "SKU", width: 12 },
      { key: "unit_price", header: "Unit Price", width: 12, format: "currency" },
      { key: "currency", header: "Currency", width: 8 },
      { key: "min_qty", header: "Min Qty", width: 8, format: "number" },
      { key: "lead_time", header: "Lead Time (days)", width: 12, format: "number" },
      { key: "preferred", header: "Preferred", width: 10 },
      { key: "valid_from", header: "Valid From", width: 12, format: "date" },
      { key: "valid_until", header: "Valid Until", width: 12, format: "date" },
      { key: "status", header: "Status", width: 16 },
      { key: "rank", header: "Sourcing Rank", width: 12, format: "number" },
    ];

    const rows = filteredList.map((e) => ({
      supplier: e.vendor?.name || "",
      product: e.product?.name || "",
      sku: e.product?.sku || "",
      unit_price: e.unit_price,
      currency: e.currency || baseCurrency,
      min_qty: e.min_order_qty,
      lead_time: e.lead_time_days,
      preferred: e.is_preferred ? "Yes" : "No",
      valid_from: e.valid_from || "",
      valid_until: e.valid_until || "",
      status: STATUS_LABEL[e.effective_status] ?? e.effective_status,
      rank: e.preferred_rank,
    }));

    return {
      title: "Supplier Conditions",
      sheetName: "supplier-conditions",
      columns,
      rows,
    };
  };

  // Stats
  const stats = useMemo(() => {
    const by = (status: string) =>
      priceLists.filter((e) => e.effective_status === status).length;

    return {
      total: priceLists.length,
      active: by("active"),
      expiringSoon: by("expiring_soon"),
      expired: by("expired"),
      pending: by("pending_approval") + by("draft"),
      preferred: priceLists.filter((e) => e.is_preferred).length,
    };
  }, [priceLists]);

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Supplier Conditions</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                The commercial conditions under which a supplier supplies a product — price, price breaks, currency, purchase unit, minimum quantity, order increment and lead time
              </p>
            </div>
            <RefreshButton queryKeyPrefixes={[["vendor-pricelists"]]} tooltip="Refresh supplier conditions" />
          </div>
          <div className="flex gap-2 flex-wrap">
            <ReportExportButtons
              getExportConfig={getExportConfig}
              formats={["excel", "csv", "print", "pdf"]}
            />
            <Button onClick={handleOpenCreate}>
              <Plus className="mr-2 h-4 w-4" /> New condition
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5" />
                Total Entries
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-muted-foreground">{stats.active} active</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Star className="h-3.5 w-3.5" />
                Preferred
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-amber-600">{stats.preferred}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Expiring Soon
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-amber-600">{stats.expiringSoon}</div>
              <p className="text-xs text-muted-foreground">Within 30 days</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                Expired
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-destructive">{stats.expired}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                Pending approval
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold">{stats.pending}</div>
              <p className="text-xs text-muted-foreground">Not yet pricing POs</p>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by supplier, product, or SKU..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full"
            />
          </div>
          <Select value={vendorFilter} onValueChange={setVendorFilter}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="Filter by supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Vendors</SelectItem>
              {vendors.map((v) => (
                <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={validityFilter} onValueChange={setValidityFilter}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue placeholder="Validity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="preferred">Preferred</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="expiring">Expiring Soon</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="pending">Pending approval</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="table-container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Min Qty</TableHead>
                <TableHead className="text-right">Lead Time</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8">Loading...</TableCell>
                </TableRow>
              ) : filteredList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No supplier conditions found. Add one to define how a supplier supplies a product.
                  </TableCell>
                </TableRow>
              ) : (
                filteredList.map((entry) => (
                  <TableRow key={entry.id} className={`cursor-pointer ${isExpired(entry) ? "opacity-60" : ""}`} onClick={() => setViewingEntry(entry)}>
                    <TableCell className="font-medium">{entry.vendor?.name || "—"}</TableCell>
                    <TableCell>
                      <div>
                        <span>{entry.product?.name || "—"}</span>
                        {entry.product?.sku && (
                          <span className="text-xs text-muted-foreground ml-2">({entry.product.sku})</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(entry.unit_price, entry.currency || baseCurrency)}
                    </TableCell>
                    <TableCell className="text-right">{entry.min_order_qty}</TableCell>
                    <TableCell className="text-right">
                      {entry.lead_time_days > 0 ? `${entry.lead_time_days}d` : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.valid_from && entry.valid_until
                        ? `${entry.valid_from} → ${entry.valid_until}`
                        : entry.valid_from
                        ? `From ${entry.valid_from}`
                        : entry.valid_until
                        ? `Until ${entry.valid_until}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 flex-wrap">
                        {entry.is_preferred && (
                          <Badge variant="default" className="bg-amber-500 text-white text-[10px] px-1.5">
                            <Star className="h-3 w-3 mr-0.5" /> Rank {entry.preferred_rank}
                          </Badge>
                        )}
                        <Badge
                          variant={
                            entry.effective_status === "expired" || entry.effective_status === "rejected"
                              ? "destructive"
                              : entry.effective_status === "active"
                              ? "default"
                              : entry.effective_status === "inactive"
                              ? "secondary"
                              : "outline"
                          }
                          className="text-[10px] px-1.5"
                        >
                          {STATUS_LABEL[entry.effective_status] ?? entry.effective_status}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewingEntry(entry)}>
                            <Eye className="mr-2 h-4 w-4" /> View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleOpenEdit(entry)}>
                            <Edit className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          {entry.preferred_rank > 1 && (
                            <DropdownMenuItem
                              onClick={() =>
                                updatePriceList({ id: entry.id, is_preferred: true, preferred_rank: 1 })
                              }
                            >
                              <Star className="mr-2 h-4 w-4" /> Make primary source
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => deletePriceList(entry.id)} className="text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <VendorPriceListFormSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) {
            setEditingId(null);
            setInitialValues(undefined);
          }
        }}
        mode={sheetMode}
        initialValues={initialValues}
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        products={products.map((p) => ({ id: p.id, name: p.name, is_active: p.is_active }))}
        baseCurrency={baseCurrency}
        onSubmit={handleSubmit}
      />

      <VendorPriceListPeekSheet
        entry={viewingEntry}
        open={!!viewingEntry}
        onOpenChange={(open) => { if (!open) setViewingEntry(null); }}
        onEdit={(entry) => { setViewingEntry(null); handleOpenEdit(entry); }}
        onDelete={(id) => deletePriceList(id)}
        onSetPreferred={(id) => updatePriceList({ id, is_preferred: true })}
      />
    </>
  );
}
