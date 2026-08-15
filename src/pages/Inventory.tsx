import { useState, useEffect, useMemo } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useInventory } from "@/hooks/useInventory";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
// useInventoryRealtime is mounted by InventoryLayout — do NOT mount here too.
import { useQuery } from "@tanstack/react-query";
import { StockCell } from "@/components/products/StockCell";
import { SourceDocumentBadge } from "@/components/inventory/SourceDocumentBadge";
import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { SourceDocumentPeekSheet } from "@/components/inventory/SourceDocumentPeekSheet";
import { StockMovementPeekSheet } from "@/components/inventory/StockMovementPeekSheet";
import { WarehouseStockPeekSheet } from "@/components/inventory/WarehouseStockPeekSheet";
import { AdjustmentItemsExpander } from "@/components/inventory/AdjustmentItemsExpander";
import { AdjustmentPeekSheet } from "@/components/inventory/AdjustmentPeekSheet";
import { ReverseAdjustmentDialog } from "@/components/inventory/ReverseAdjustmentDialog";
import type { StockAdjustment } from "@/hooks/useInventory";
import { exportMovementsToCSV } from "@/lib/exportMovements";
import { resolveAvailabilityFor } from "@/lib/inventory/availability";
import { useQtyFormatter } from "@/hooks/inventory/useQtyFormatter";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import { ProductBadgeStrip } from "@/components/products/ProductBadgeStrip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus, Search, Package, Loader2, AlertTriangle, ArrowUp, ArrowDown,
  History, CheckCircle, XCircle, Clock, Download,
} from "lucide-react";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { format } from "date-fns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { productBaseLabelOrUnset, PRODUCT_BASE_UOM_SELECT } from "@/lib/inventory/uom";

const PAGE_SIZE = 50;

export default function Inventory() {
  const {
    stockAdjustments,
    lowStockProducts,
    isLoading: hookLoading,
    approveStockAdjustment,
    cancelStockAdjustment,
    reverseStockAdjustment,
  } = useInventory();
  const { products } = useProducts();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { isReadOnly } = useSubscriptionAccess();
  // Realtime subscription owned by InventoryLayout (one channel per app session).
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id;
  const navigate = useNavigate();

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [movementTypeFilter, setMovementTypeFilter] = useState("all");
  const [warehouseFilter, setWarehouseFilter] = useState("all");

  // Pagination
  const [movementPage, setMovementPage] = useState(1);
  const [stockLevelPage, setStockLevelPage] = useState(1);

  const [isExporting, setIsExporting] = useState(false);

  // Drawer state
  const [productDrawerOpen, setProductDrawerOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [sourceDocDrawerOpen, setSourceDocDrawerOpen] = useState(false);
  const [selectedRefType, setSelectedRefType] = useState<string | null>(null);
  const [selectedRefId, setSelectedRefId] = useState<string | null>(null);
  const [movementDrawerOpen, setMovementDrawerOpen] = useState(false);
  const [selectedMovementId, setSelectedMovementId] = useState<string | null>(null);
  const [warehouseStockDrawerOpen, setWarehouseStockDrawerOpen] = useState(false);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>(null);
  const [selectedWarehouseName, setSelectedWarehouseName] = useState<string | null>(null);
  const [adjustmentDrawerOpen, setAdjustmentDrawerOpen] = useState(false);
  const [selectedAdjustmentId, setSelectedAdjustmentId] = useState<string | null>(null);
  // Reverse-adjustment dialog state (Wave 2 / Gap #1).
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<StockAdjustment | null>(null);
  // O(1) lookup map for "Reverses #X" badge → display original number.
  const adjustmentNumberById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of stockAdjustments) m.set(a.id, a.adjustment_number);
    return m;
  }, [stockAdjustments]);

  // Hoisted ABOVE the deep-link effects below so the dependency array (which
  // is read inline during render) does not trigger a TDZ error on
  // `inventoryProducts`. This memo was previously declared ~200 lines down,
  // which crashed the page the first time the deep link `?action=adjust`
  // forced React to evaluate those effect dep arrays during render.
  const inventoryProducts = useMemo(
    () => products.filter((p) => p.type === "product"),
    [products],
  );
  // Warehouses for filters + adjustment dialog. We pull is_default and
  // branch_id so the Adjust Stock dialog can pick the right warehouse
  // automatically based on the active branch context (no hardcoded UUIDs).
  const [warehouses, setWarehouses] = useState<{id: string; name: string; is_default: boolean | null; branch_id: string | null}[]>([]);
  useEffect(() => {
    if (organizationId) {
      let q = supabase.from("warehouses").select("id, name, is_default, branch_id")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        // In-transit buckets are bookkeeping, never an operational choice.
        .or("is_in_transit.is.null,is_in_transit.eq.false");

      if (businessId) q = q.eq("business_id", businessId);
      if (branchId) q = q.eq("branch_id", branchId);
      q.then(({ data }) => setWarehouses(data || []));
    }
  }, [organizationId, businessId, branchId]);

  // Deep-link prefill: /inventory/stock?action=adjust&product=<id>
  // Used by Products.tsx to send the user here with a pre-filled adjustment row.
  // Deep-link redirect: /inventory-app/stock?action=adjust&product=<id>
  // Products.tsx sends users here; forward them to the routed create page.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("action") !== "adjust") return;
    const productId = searchParams.get("product");
    const query = new URLSearchParams();
    if (productId) query.set("product", productId);
    query.set("reason", "opening_balance");
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    next.delete("product");
    setSearchParams(next, { replace: true });
    navigate(`/inventory-app/adjustments/new?${query.toString()}`);
  }, [searchParams, setSearchParams, navigate]);




  // ===== SERVER-SIDE PAGINATED MOVEMENTS =====
  const { data: movementsData, isLoading: movementsLoading } = useQuery({
    queryKey: ["stock-movements-paginated", organizationId, businessId, branchId, movementPage, searchQuery, dateFrom, dateTo, movementTypeFilter, warehouseFilter],
    queryFn: async () => {
      if (!organizationId || !businessId) return { data: [], count: 0 };
      const from = (movementPage - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from("stock_movements")
        .select("*, products(id, name, sku), warehouses(id, name)", { count: "exact" })
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("movement_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (branchId) query = query.eq("branch_id", branchId);
      if (movementTypeFilter !== "all") query = query.eq("movement_type", movementTypeFilter);
      if (warehouseFilter !== "all") query = query.eq("warehouse_id", warehouseFilter);
      if (dateFrom) query = query.gte("movement_date", dateFrom);
      if (dateTo) query = query.lte("movement_date", dateTo + "T23:59:59");
      if (searchQuery) {
        // Can't ilike on joined table easily, so we search by product_id from a separate lookup
        // For now, keep it server-side on notes
        query = query.or(`notes.ilike.%${searchQuery}%`);
      }

      query = query.range(from, to);
      const { data, error, count } = await query;
      if (error) throw error;
      return { data: data || [], count: count || 0 };
    },
    enabled: !!organizationId && !!businessId,
    placeholderData: (prev) => prev,
  });

  const movements = movementsData?.data || [];
  const movementsTotalCount = movementsData?.count || 0;
  const movementsTotalPages = Math.ceil(movementsTotalCount / PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => { setMovementPage(1); }, [searchQuery, dateFrom, dateTo, movementTypeFilter, warehouseFilter]);

  // ===== SERVER-SIDE PAGINATED STOCK LEVELS =====
  const { data: stockLevelsData, isLoading: stockLevelsLoading } = useQuery({
    queryKey: ["stock-levels-paginated", organizationId, businessId, branchId, stockLevelPage],
    queryFn: async () => {
      if (!organizationId || !businessId) return { data: [], count: 0 };
      const from = (stockLevelPage - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data, error, count } = await supabase
        .from("products")
        .select(
          `id, name, sku, reorder_level, cost_price, type, track_inventory, status, ${PRODUCT_BASE_UOM_SELECT}`,
          { count: "exact" },
        )
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("type", "product")
        .eq("status", "active")
        .order("name")
        .range(from, to);

      if (error) throw error;
      const products = data || [];
      // ADR 0142: availability is a server decision. One batch call to the
      // canonical engine — never derived by browser arithmetic.
      const availability = await resolveAvailabilityFor(
        products.map((p: any) => p.id),
        { businessId, branchId: branchId ?? null },
      );
      const enriched = products.map((p: any) => {
        const a = availability.get(p.id);
        return {
          ...p,
          on_hand: a?.onHand ?? 0,
          on_hand_reserved: a?.reserved ?? 0,
          on_hand_available: a?.available ?? 0,
        };
      });
      return { data: enriched, count: count || 0 };

    },
    enabled: !!organizationId && !!businessId,
    placeholderData: (prev) => prev,
  });

  const stockLevelProducts = stockLevelsData?.data || [];
  const stockLevelsTotalPages = Math.ceil((stockLevelsData?.count || 0) / PAGE_SIZE);
  
  const productIds = stockLevelProducts.map((p: any) => p.id);
  // Pack-aware quantity formatter for the Stock-on-Hand table. Looks up
  // product_packaging once per render so operators see "2 Carton + 3 ea"
  // instead of "51 ea". Falls back to "<base> ea" when no packs are defined.
  const stockQtyFormatter = useQtyFormatter({ productIds });
  // Pack-rows + multi-uom presence for listing rows.
  const { packsByProduct, hasPackagingSet } = useProductPackagingBatch(productIds);
  // On-hand / reserved / available all arrive from the availability engine
  // with the page query above — no second read model, no local arithmetic.


  // Incoming stock from open POs — MUST be company- and branch-scoped.
  // Filtering by organization_id alone leaks other companies' open POs into
  // this company's "incoming" KPI in a multi-business workspace.
  const { data: incomingMap = new Map() } = useQuery({
    queryKey: ["incoming-stock", organizationId, businessId, branchId],
    queryFn: async () => {
      if (!organizationId || !businessId) return new Map<string, number>();
      let q = supabase
        .from("purchase_order_items")
        .select("product_id, quantity, received_quantity, purchase_orders!inner(status, organization_id, business_id, branch_id)")
        .eq("purchase_orders.organization_id", organizationId)
        .eq("purchase_orders.business_id", businessId)
        .in("purchase_orders.status", ["draft", "sent", "partial_received"]);
      if (branchId) q = q.eq("purchase_orders.branch_id", branchId);
      const { data } = await q;
      const map = new Map<string, number>();
      (data || []).forEach((item: any) => {
        const pending = (item.quantity || 0) - (item.received_quantity || 0);
        if (pending > 0) {
          map.set(item.product_id, (map.get(item.product_id) || 0) + pending);
        }
      });
      return map;
    },
    enabled: !!organizationId && !!businessId,
  });

  // `inventoryProducts` is declared near the top of this component (above the
  // deep-link effects) to avoid a TDZ crash. Do NOT re-declare it here.

  // Handlers
  const handleOpenProductDrawer = (productId: string) => { setSelectedProductId(productId); setProductDrawerOpen(true); };
  const handleOpenSourceDocDrawer = (type: string, id: string) => { setSelectedRefType(type); setSelectedRefId(id); setSourceDocDrawerOpen(true); };
  const handleOpenMovementDrawer = (movementId: string) => { setSelectedMovementId(movementId); setMovementDrawerOpen(true); };
  const handleOpenWarehouseStock = (whId: string, whName: string) => { setSelectedWarehouseId(whId); setSelectedWarehouseName(whName); setWarehouseStockDrawerOpen(true); };
  const handleOpenAdjustmentDrawer = (adjId: string) => { setSelectedAdjustmentId(adjId); setAdjustmentDrawerOpen(true); };




  const handleExport = async () => {
    if (!organizationId) return;
    setIsExporting(true);
    try {
      const count = await exportMovementsToCSV(organizationId, businessId || null, {
        dateFrom, dateTo, movementType: movementTypeFilter,
        warehouseId: warehouseFilter !== "all" ? warehouseFilter : undefined,
      });
      toast.success(`Exported ${count} movements to CSV`);
    } catch (err: any) {
      toast.error("Export failed: " + normalizeError(err).message);
    } finally { setIsExporting(false); }
  };

  const getMovementBadge = (type: string) => {
    const badges: Record<string, { className: string; label: string }> = {
      purchase: { className: "bg-green-100 text-green-800", label: "Purchase" },
      receipt: { className: "bg-green-100 text-green-800", label: "Receipt" },
      sale: { className: "bg-blue-100 text-blue-800", label: "Sale" },
      pos_sale: { className: "bg-blue-100 text-blue-800", label: "POS Sale" },
      delivery: { className: "bg-blue-100 text-blue-800", label: "Delivery" },
      adjustment: { className: "bg-yellow-100 text-yellow-800", label: "Adjustment" },
      count: { className: "bg-yellow-100 text-yellow-800", label: "Count" },
      return_in: { className: "bg-purple-100 text-purple-800", label: "Return In" },
      pos_return: { className: "bg-purple-100 text-purple-800", label: "POS Return" },
      return_out: { className: "bg-orange-100 text-orange-800", label: "Return Out" },
      transfer: { className: "bg-cyan-100 text-cyan-800", label: "Transfer" },
      scrap: { className: "bg-red-100 text-red-800", label: "Scrap" },
      opening: { className: "bg-gray-100 text-gray-800", label: "Opening" },
    };
    const b = badges[type];
    return b ? <Badge className={b.className}>{b.label}</Badge> : <Badge variant="outline">{type}</Badge>;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft": return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Draft</Badge>;
      case "pending_approval": return <Badge className="bg-amber-100 text-amber-800"><Clock className="h-3 w-3 mr-1" />Pending Approval</Badge>;
      case "approved": return <Badge className="bg-green-100 text-green-800"><CheckCircle className="h-3 w-3 mr-1" />Applied</Badge>;
      case "cancelled": return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Cancelled</Badge>;
      case "reversed": return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Reversed</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const isLoading = hookLoading || movementsLoading;

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Inventory Management</h1>
            <p className="text-sm sm:text-base text-muted-foreground">Track stock levels, movements, and adjustments</p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton
              queryKeyPrefixes={[
                ["stock-movements"] as const,
                ["stock-movements-paginated"] as const,
                ["warehouse-stock-totals"] as const,
                ["stock-levels-paginated"] as const,
                ["low-stock-products"] as const,
                
                ["stock-adjustments"] as const,
              ]}
              tooltip="Refresh inventory"
            />
            <PermissionGate permission="manageProducts">
              <Button asChild className="w-full sm:w-auto">
                <Link to="/inventory-app/adjustments/new">
                  <Plus className="mr-2 h-4 w-4" />Stock Adjustment
                </Link>
              </Button>
            </PermissionGate>
          </div>
        </div>

        {/* Low Stock Alert */}
        {lowStockProducts.length > 0 && (
          <Card className="border-warning bg-warning/5">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-warning"><AlertTriangle className="h-5 w-5" />Low Stock Alert</CardTitle>
              <CardDescription>{lowStockProducts.length} product(s) below reorder level</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {lowStockProducts.map(p => (
                  <Badge key={p.id} variant="outline" className="border-warning text-warning cursor-pointer hover:bg-warning/10"
                    onClick={() => handleOpenProductDrawer(p.id)}>
                    {p.name}: {p.stock_quantity} (min: {p.reorder_level})
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Products</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{inventoryProducts.length}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Low Stock Items</CardTitle>
              <AlertTriangle className="h-4 w-4 text-warning" />
            </CardHeader>
            <CardContent><div className="text-2xl font-bold text-warning">{lowStockProducts.length}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Movements</CardTitle>
              <History className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{movementsTotalCount}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Adjustments</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stockAdjustments.filter(a => a.status === "draft").length}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="movements" className="space-y-4">
          <TabsList>
            <TabsTrigger value="movements">Stock Movements</TabsTrigger>
            <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
            <TabsTrigger value="levels">Stock Levels</TabsTrigger>
          </TabsList>

          {/* ===== MOVEMENTS TAB ===== */}
          <TabsContent value="movements">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
                    <CardTitle className="min-w-0 break-words">Stock Movements</CardTitle>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto min-w-0">
                      <Button variant="outline" size="sm" onClick={handleExport} disabled={isExporting} className="w-full sm:w-auto">
                        {isExporting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
                        Export CSV
                      </Button>
                      <div className="relative w-full sm:w-48 min-w-0">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input placeholder="Search notes..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10 w-full" />
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
                    <Select value={movementTypeFilter} onValueChange={setMovementTypeFilter}>
                      <SelectTrigger className="w-[140px]"><SelectValue placeholder="All Types" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="purchase">Purchase</SelectItem>
                        <SelectItem value="sale">Sale</SelectItem>
                        <SelectItem value="pos_sale">POS Sale</SelectItem>
                        <SelectItem value="adjustment">Adjustment</SelectItem>
                        <SelectItem value="transfer">Transfer</SelectItem>
                        <SelectItem value="receipt">Receipt</SelectItem>
                        <SelectItem value="delivery">Delivery</SelectItem>
                        <SelectItem value="return_in">Return In</SelectItem>
                        <SelectItem value="return_out">Return Out</SelectItem>
                        <SelectItem value="scrap">Scrap</SelectItem>
                        <SelectItem value="opening">Opening</SelectItem>
                        <SelectItem value="count">Count</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                      <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Warehouses</SelectItem>
                        {warehouses.map(w => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {(dateFrom || dateTo || movementTypeFilter !== "all" || warehouseFilter !== "all") && (
                      <Button variant="ghost" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); setMovementTypeFilter("all"); setWarehouseFilter("all"); }}>
                        Clear Filters
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {movementsLoading && movements.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : movements.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <History className="h-12 w-12 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium">No stock movements</h3>
                    <p className="text-muted-foreground">Stock movements will appear here</p>
                  </div>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Reference</TableHead>
                          <TableHead>Warehouse</TableHead>
                          <TableHead className="text-right">Quantity</TableHead>
                          <TableHead className="text-right">Unit Cost</TableHead>
                          <TableHead>Notes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {movements.map((movement: any) => (
                          <TableRow key={movement.id} className="cursor-pointer hover:bg-muted/50" onClick={() => handleOpenMovementDrawer(movement.id)}>
                            <TableCell>{format(new Date(movement.movement_date), "MMM d, yyyy")}</TableCell>
                            <TableCell>
                              <button className="font-medium text-primary hover:underline text-left"
                                onClick={(e) => { e.stopPropagation(); handleOpenProductDrawer(movement.product_id); }}>
                                {movement.products?.name}
                              </button>
                            </TableCell>
                            <TableCell>{getMovementBadge(movement.movement_type)}</TableCell>
                            <TableCell onClick={(e) => e.stopPropagation()}>
                              <SourceDocumentBadge referenceType={movement.reference_type} referenceId={movement.reference_id} onOpenDrawer={handleOpenSourceDocDrawer} />
                            </TableCell>
                            <TableCell>
                              {movement.warehouses?.name ? (
                                <button className="text-primary hover:underline text-left text-sm"
                                  onClick={(e) => { e.stopPropagation(); handleOpenWarehouseStock(movement.warehouses!.id, movement.warehouses!.name); }}
                                  title={`View stock in ${movement.warehouses!.name}`}>
                                  {movement.warehouses.name}
                                </button>
                              ) : "-"}
                            </TableCell>
                            <TableCell className="text-right">
                              <span className={movement.quantity >= 0 ? "text-green-600" : "text-red-600"}>
                                {movement.quantity >= 0 ? <ArrowUp className="inline h-3 w-3 mr-1" /> : <ArrowDown className="inline h-3 w-3 mr-1" />}
                                {Math.abs(movement.quantity)}
                              </span>
                            </TableCell>
                            <TableCell className="text-right">{movement.unit_cost ? formatCurrency(movement.unit_cost) : "-"}</TableCell>
                            <TableCell className="max-w-xs truncate">{movement.notes || "-"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {/* Pagination */}
                    <div className="flex items-center justify-between pt-4">
                      <p className="text-sm text-muted-foreground">
                        Showing {((movementPage - 1) * PAGE_SIZE) + 1}–{Math.min(movementPage * PAGE_SIZE, movementsTotalCount)} of {movementsTotalCount}
                      </p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={movementPage <= 1} onClick={() => setMovementPage(p => p - 1)}>Previous</Button>
                        <Button variant="outline" size="sm" disabled={movementPage >= movementsTotalPages} onClick={() => setMovementPage(p => p + 1)}>Next</Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== ADJUSTMENTS TAB ===== */}
          <TabsContent value="adjustments">
            <Card>
              <CardHeader>
                <CardTitle>Stock Adjustments</CardTitle>
                <CardDescription>Manual inventory adjustments and corrections</CardDescription>
              </CardHeader>
              <CardContent>
                {stockAdjustments.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Package className="h-12 w-12 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium">No adjustments</h3>
                    <p className="text-muted-foreground">Create a stock adjustment to correct inventory</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Number</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Items</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stockAdjustments.map((adjustment) => (
                        <TableRow key={adjustment.id}>
                          <TableCell className="font-medium">
                            <div className="flex flex-col gap-1">
                              <span>{adjustment.adjustment_number}</span>
                              {adjustment.reverses_adjustment_id && (
                                <Badge variant="outline" className="w-fit text-xs">
                                  Reverses #{adjustmentNumberById.get(adjustment.reverses_adjustment_id) ?? adjustment.reverses_adjustment_id.slice(0, 8)}
                                </Badge>
                              )}
                              {adjustment.reversed_by_adjustment_id && (
                                <Badge variant="destructive" className="w-fit text-xs">
                                  Reversed by #{adjustmentNumberById.get(adjustment.reversed_by_adjustment_id) ?? adjustment.reversed_by_adjustment_id.slice(0, 8)}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>{format(new Date(adjustment.adjustment_date), "MMM d, yyyy")}</TableCell>
                          <TableCell>{adjustment.reason}</TableCell>
                          <TableCell>
                            <AdjustmentItemsExpander items={adjustment.items || []} />
                          </TableCell>
                          <TableCell>{getStatusBadge(adjustment.status)}</TableCell>
                          <TableCell>
                            {adjustment.status === "pending_approval" && (
                              <PermissionGate permission="manageProducts">
                                <div className="flex gap-2">
                                  <Button size="sm" onClick={() => approveStockAdjustment.mutateAsync(adjustment.id)}>Approve</Button>
                                  <Button size="sm" variant="outline" onClick={() => cancelStockAdjustment.mutateAsync(adjustment.id)}>Reject</Button>
                                </div>
                              </PermissionGate>
                            )}
                            {adjustment.status === "draft" && (
                              <PermissionGate permission="manageProducts">
                                <Button size="sm" variant="outline" onClick={() => cancelStockAdjustment.mutateAsync(adjustment.id)}>Cancel</Button>
                              </PermissionGate>
                            )}
                            {adjustment.status === "approved"
                              && !adjustment.reversed_by_adjustment_id
                              && !adjustment.reverses_adjustment_id && (
                              <PermissionGate permission="manageProducts">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setReverseTarget(adjustment);
                                    setReverseOpen(true);
                                  }}
                                >
                                  Reverse
                                </Button>
                              </PermissionGate>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== STOCK LEVELS TAB ===== */}
          <TabsContent value="levels">
            <Card>
              <CardHeader>
                <CardTitle>Current Stock Levels</CardTitle>
                <CardDescription>On hand, reserved, available, and incoming inventory</CardDescription>
              </CardHeader>
              <CardContent>
                {stockLevelsLoading && stockLevelProducts.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead className="text-right">On Hand</TableHead>
                          <TableHead className="text-right">Reserved</TableHead>
                          <TableHead className="text-right">Available</TableHead>
                          <TableHead className="text-right">Incoming</TableHead>
                          <TableHead className="text-right">Reorder Level</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stockLevelProducts.map((product: any) => {
                          const stockQty = product.on_hand ?? 0;
                          const reorderLevel = product.reorder_level || 0;
                          const reserved = product.on_hand_reserved ?? 0;
                          const available = product.on_hand_available ?? 0;

                          const incoming = incomingMap.get(product.id) || 0;
                          const isLow = reorderLevel > 0 && stockQty <= reorderLevel;
                          const trackInventory = product.track_inventory !== false && product.type !== "service";
                          const packs = packsByProduct.get(product.id);
                          const baseLabel = productBaseLabelOrUnset(product as any);

                          return (
                            <TableRow key={product.id}>
                              <TableCell>
                                <div className="flex flex-wrap items-center gap-2">
                                  <button className="font-medium text-primary hover:underline text-left"
                                    onClick={() => handleOpenProductDrawer(product.id)}>
                                    {product.name}
                                  </button>
                                  <ProductBadgeStrip
                                    product={product}
                                    hasPackaging={hasPackagingSet.has(product.id)}
                                  />
                                </div>
                              </TableCell>
                              <TableCell>{product.sku || "-"}</TableCell>
                              <TableCell className="text-right">
                                <StockCell
                                  value={stockQty}
                                  reorderLevel={reorderLevel}
                                  trackInventory={trackInventory}
                                  packs={packs}
                                  baseLabel={baseLabel}
                                />
                              </TableCell>
                              <TableCell className="text-right">
                                {reserved > 0 ? <span className="text-orange-600 font-medium">{reserved}</span> : <span className="text-muted-foreground">0</span>}
                              </TableCell>
                              <TableCell className="text-right font-semibold">
                                <div className="flex flex-col items-end leading-tight">
                                  <span>{available}</span>
                                  {stockQtyFormatter.isReady && available > 0 && (
                                    <span className="text-[10px] text-muted-foreground font-normal">
                                      {stockQtyFormatter.format(product.id, available)}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                {incoming > 0 ? <span className="text-blue-600 font-medium">+{incoming}</span> : <span className="text-muted-foreground">0</span>}
                              </TableCell>
                              <TableCell className="text-right">{reorderLevel || "-"}</TableCell>
                              <TableCell>
                                {isLow ? <Badge variant="destructive">Low Stock</Badge>
                                  : available <= 0 ? <Badge variant="outline">Out of Stock</Badge>
                                  : <Badge className="bg-green-100 text-green-800">In Stock</Badge>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    {/* Pagination */}
                    <div className="flex items-center justify-between pt-4">
                      <p className="text-sm text-muted-foreground">
                        Page {stockLevelPage} of {Math.max(1, stockLevelsTotalPages)} ({stockLevelsData?.count || 0} products)
                      </p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={stockLevelPage <= 1} onClick={() => setStockLevelPage(p => p - 1)}>Previous</Button>
                        <Button variant="outline" size="sm" disabled={stockLevelPage >= stockLevelsTotalPages} onClick={() => setStockLevelPage(p => p + 1)}>Next</Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

      </div>

      {/* Drawers */}
      <ProductDetailPanel open={productDrawerOpen} onOpenChange={setProductDrawerOpen} productId={selectedProductId} />
      <SourceDocumentPeekSheet open={sourceDocDrawerOpen} onOpenChange={setSourceDocDrawerOpen} referenceType={selectedRefType} referenceId={selectedRefId} />
      <StockMovementPeekSheet
        open={movementDrawerOpen}
        onOpenChange={setMovementDrawerOpen}
        movementId={selectedMovementId}
        onOpenProductDrawer={handleOpenProductDrawer}
        onOpenWarehouseDrawer={handleOpenWarehouseStock}
        onOpenSourceDocDrawer={handleOpenSourceDocDrawer}
      />
      <WarehouseStockPeekSheet open={warehouseStockDrawerOpen} onOpenChange={setWarehouseStockDrawerOpen} warehouseId={selectedWarehouseId} warehouseName={selectedWarehouseName} organizationId={organizationId} />
      <AdjustmentPeekSheet open={adjustmentDrawerOpen} onOpenChange={setAdjustmentDrawerOpen} adjustmentId={selectedAdjustmentId} />
      <ReverseAdjustmentDialog
        adjustment={reverseTarget}
        open={reverseOpen}
        onOpenChange={(open) => {
          setReverseOpen(open);
          if (!open) setReverseTarget(null);
        }}
        isPending={reverseStockAdjustment.isPending}
        onConfirm={async (reason) => {
          if (!reverseTarget) return;
          try {
            await reverseStockAdjustment.mutateAsync({
              adjustmentId: reverseTarget.id,
              reason,
            });
            setReverseOpen(false);
            setReverseTarget(null);
          } catch {
            // toast handled in hook; keep dialog open so user can retry
          }
        }}
      />
    </>
  );
}
