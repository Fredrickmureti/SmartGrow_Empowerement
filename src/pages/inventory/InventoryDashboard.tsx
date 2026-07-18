import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Package, AlertTriangle, ArrowRight, History, Clock, Warehouse, TrendingUp, TrendingDown, CalendarClock, MinusCircle, Flame } from "lucide-react";
import { useInventory, usePendingAdjustmentsCount, useTodayMovementCounts } from "@/hooks/useInventory";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
// useInventoryRealtime is mounted by InventoryLayout — do NOT mount here too.
import { useWarehouseStockTotals } from "@/hooks/useWarehouseStockTotals";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useDashboardComposition } from "@/hooks/useDashboardComposition";
import { ExpiringLotsCard } from "@/components/inventory/ExpiringLotsCard";
import { useDashboardIntelligence } from "@/hooks/inventory/useDashboardIntelligence";
import { formatQtyWithPacks } from "@/lib/inventory/formatQty";

/**
 * Inventory Module Dashboard — Stock overview, low stock alerts, movements, valuation
 */
export default function InventoryDashboard() {
  const navigate = useNavigate();
  const composition = useDashboardComposition();
  const { stockMovements, lowStockProducts, isLoading: invLoading } = useInventory();
  const { products, isLoading: prodLoading } = useProducts();
  const { formatCurrency } = useCurrency();
  // Realtime subscription owned by InventoryLayout (one channel per app session).
  // Branch-true valuation. Reads warehouse_stock filtered by (business, branch?)
  // — never products.stock_quantity, which is a company-wide aggregate.
  const {
    totalStockValue,
    totalRetailValue,
    scopeLabel,
    isLoading: totalsLoading,
  } = useWarehouseStockTotals();

  // Phase F — server-side counters that never undercount and that understand
  // the smart-routing RPC's `pending_approval` status string.
  const { data: pendingAdjustmentsCount = 0 } = usePendingAdjustmentsCount();
  const { data: todayCounts = { inbound: 0, outbound: 0, total: 0 } } =
    useTodayMovementCounts();

  // Branch-scoped intelligence aggregates (expiring soon / negative stock /
  // top movers). Single hook, 60s staleTime, no extra subscriptions.
  const { data: intel } = useDashboardIntelligence();

  const isLoading = invLoading || prodLoading || totalsLoading;

  const inventoryProducts = products.filter(p => p.type === "product");

  // Movement breakdown — recent list still uses the in-memory feed for the
  // "Recent Movements" card, but the headline counters above come from the
  // server counts so a 500-row cap can never silently lie.
  const recentMovements = stockMovements.slice(0, 10);
  const inboundToday = todayCounts.inbound;
  const outboundToday = todayCounts.outbound;
  const todayMovementsCount = todayCounts.total;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="page-title">Inventory Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Stock levels, alerts, valuations, and recent movements
          </p>
        </div>
        <RefreshButton
          queryKeyPrefixes={[
            ["stock-movements"] as const,
            ["stock-adjustments"] as const,
            ["low-stock-products"] as const,
            ["warehouse-stock-totals"] as const,
            ["stock-levels-paginated"] as const,
            ["products-list-stock"] as const,
          ]}
          tooltip="Refresh inventory dashboard"
        />
      </div>

      {/* Low Stock Alert */}
      {lowStockProducts.length > 0 && (
        <Card className="border-warning bg-warning/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-warning text-base">
              <AlertTriangle className="h-5 w-5" />
              Low Stock Alert — {lowStockProducts.length} product{lowStockProducts.length !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {lowStockProducts.slice(0, 8).map((p: any) => (
                <Badge key={p.id} variant="outline" className="border-warning text-warning">
                  {p.name}: {p.stock_quantity}
                  {p.warehouse_name ? ` @ ${p.warehouse_name}` : ""}
                  {" "}(min: {p.reorder_level})
                </Badge>
              ))}
              {lowStockProducts.length > 8 && (
                <Badge variant="outline" className="border-warning text-warning">
                  +{lowStockProducts.length - 8} more
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Phase 8 — expiry alerts. Self-hides when no product opts in. */}
      <ExpiringLotsCard />



      {/* Stats Cards — role-gated; cashier/sales see only Quick Actions below. */}
      {composition.allowsWidget("inventory.kpis") && (
      <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-purple-500 min-w-0" onClick={() => navigate("/inventory-app/products")}>
          <CardHeader className="pb-2 px-3 sm:px-6">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <CardTitle className="text-xs sm:text-sm font-medium truncate">Total Products</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 min-w-0">
            <div className="text-xl sm:text-2xl font-bold text-primary break-words">{inventoryProducts.length}</div>
            <p className="text-xs text-muted-foreground mt-1 break-words">tracked inventory items</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-amber-500 min-w-0" onClick={() => navigate("/inventory-app/stock")}>
          <CardHeader className="pb-2 px-3 sm:px-6">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <CardTitle className="text-xs sm:text-sm font-medium truncate">Low Stock</CardTitle>
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
            </div>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 min-w-0">
            <div className="text-xl sm:text-2xl font-bold text-warning break-words">{lowStockProducts.length}</div>
            <p className="text-xs text-muted-foreground mt-1 break-words">below reorder level</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-blue-500 min-w-0">
          <CardHeader className="pb-2 px-3 sm:px-6">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <CardTitle className="text-xs sm:text-sm font-medium truncate">Movements Today</CardTitle>
              <History className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 min-w-0">
            <div className="text-xl sm:text-2xl font-bold text-primary break-words">{todayMovementsCount}</div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {inboundToday > 0 && (
                <Badge variant="secondary" className="text-xs">
                  <TrendingUp className="h-3 w-3 mr-1" />{inboundToday} in
                </Badge>
              )}
              {outboundToday > 0 && (
                <Badge variant="outline" className="text-xs">
                  <TrendingDown className="h-3 w-3 mr-1" />{outboundToday} out
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500 min-w-0">
          <CardHeader className="pb-2 px-3 sm:px-6">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <CardTitle className="text-xs sm:text-sm font-medium truncate">Pending Adjustments</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 min-w-0">
            <div className="text-xl sm:text-2xl font-bold text-primary break-words">{pendingAdjustmentsCount}</div>
            <p className="text-xs text-muted-foreground mt-1 break-words">awaiting approval</p>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Stock Valuation */}
      {composition.allowsWidget("inventory.valuation") && (
      <Card>

        <CardHeader className="pb-3">
          <CardTitle className="text-base">Stock Valuation</CardTitle>
          <CardDescription className="break-words">
            Estimated value of current inventory · <span className="font-medium">{scopeLabel}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 max-w-3xl">
            <div className="flex flex-col items-center justify-center text-center p-3 sm:p-4 lg:p-6 rounded-lg bg-muted/50 min-w-0">
              <div className="text-base sm:text-xl lg:text-2xl font-bold break-words leading-tight w-full">
                {formatCurrency(totalStockValue)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Cost Value</div>
            </div>
            <div className="flex flex-col items-center justify-center text-center p-3 sm:p-4 lg:p-6 rounded-lg bg-muted/50 min-w-0">
              <div className="text-base sm:text-xl lg:text-2xl font-bold break-words leading-tight w-full">
                {formatCurrency(totalRetailValue)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Retail Value</div>
            </div>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Inventory Intelligence — branch-scoped operational signals */}
      {composition.allowsWidget("inventory.kpis") && intel && (
        <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-3">
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-rose-500 min-w-0"
            onClick={() => navigate("/inventory-app/stock?filter=expiring")}
          >
            <CardHeader className="pb-2 px-3 sm:px-6">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <CardTitle className="text-xs sm:text-sm font-medium truncate">Expiring soon</CardTitle>
                <CalendarClock className="h-4 w-4 text-rose-500 shrink-0" />
              </div>
            </CardHeader>
            <CardContent className="px-3 sm:px-6 min-w-0">
              <div className="text-xl sm:text-2xl font-bold break-words">{intel.expiringSoon.count}</div>
              {intel.expiringSoon.sample.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {intel.expiringSoon.sample.slice(0, 3).map((s) => (
                    <li key={s.id} className="truncate">
                      {s.name} <span className="opacity-70">· {s.days ?? "?"}d</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">No lots within alert window</p>
              )}
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-red-600 min-w-0"
            onClick={() => navigate("/inventory-app/stock?filter=negative")}
          >
            <CardHeader className="pb-2 px-3 sm:px-6">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <CardTitle className="text-xs sm:text-sm font-medium truncate">Negative stock</CardTitle>
                <MinusCircle className="h-4 w-4 text-destructive shrink-0" />
              </div>
            </CardHeader>
            <CardContent className="px-3 sm:px-6 min-w-0">
              <div className="text-xl sm:text-2xl font-bold text-destructive break-words">{intel.negativeStock.count}</div>
              {intel.negativeStock.sample.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {intel.negativeStock.sample.slice(0, 3).map((s) => (
                    <li key={s.id} className="truncate">
                      {s.name} <span className="opacity-70">· {s.quantity}{s.warehouse ? ` @ ${s.warehouse}` : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">All positions are non-negative</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-emerald-500 min-w-0">
            <CardHeader className="pb-2 px-3 sm:px-6">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <CardTitle className="text-xs sm:text-sm font-medium truncate">Top movers · 28d</CardTitle>
                <Flame className="h-4 w-4 text-emerald-500 shrink-0" />
              </div>
            </CardHeader>
            <CardContent className="px-3 sm:px-6 min-w-0">
              {intel.topMovers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No outbound movement in the last 28 days.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {intel.topMovers.map((m) => (
                    <li
                      key={m.productId}
                      className="flex items-center justify-between gap-2 cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
                      onClick={() => navigate(`/inventory-app/stock?product=${m.productId}`)}
                    >
                      <span className="truncate">{m.name}</span>
                      <span className="whitespace-nowrap text-muted-foreground">
                        {formatQtyWithPacks(m.baseQty, [], m.uom)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/inventory-app/products")}>
              Products <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/inventory-app/stock")}>
              Stock Levels <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/warehouse-app/warehouses")}>
              Warehouses <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/inventory-app/replenishment")}>
              Replenishment <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
