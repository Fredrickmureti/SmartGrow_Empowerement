import { normalizeError } from "@/services/resilience";
/**
 * ProductStockPanel — Odoo-grade guided UX for the read-only stock totals
 * shown in the product form. Replaces the plain disabled `stock_quantity`
 * input with:
 *   - Branch-aware on-hand / reserved / available / forecasted tiles
 *   - Per-warehouse breakdown for the active branch (with show-other-branches)
 *   - Inline per-warehouse reorder threshold editor (writes ONLY to
 *     warehouse_stock.reorder_level — never to products.*)
 *   - Action row: Adjust, Transfer, Receive (PO), View movements,
 *     Forecast, Valuation report
 *   - Smart empty state when on-hand = 0 across the visible scope
 *
 * Source of truth: warehouse_stock(product_id, warehouse_id, branch_id).
 * Never reads or writes products.stock_quantity. Architecture-test safe.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { resolveAvailability } from "@/lib/inventory/availability";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeftRight,
  ArrowDownToLine,
  ClipboardEdit,
  History,
  Info,
  LineChart,
  Loader2,
  PackagePlus,
  TrendingUp,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { toast } from "sonner";

interface ProductStockPanelProps {
  productId: string;
  productName?: string;
  costPrice?: number;
  unitPrice?: number;
}

interface WarehouseStockRow {
  id: string;
  warehouse_id: string;
  branch_id: string | null;
  quantity: number;
  reserved_quantity: number;
  reorder_level: number | null;
  warehouses: {
    id: string;
    name: string;
    code: string | null;
    branch_id: string | null;
    is_in_transit: boolean | null;
  } | null;
  branches?: { id: string; name: string } | null;
}

export function ProductStockPanel({
  productId,
  productName,
  costPrice = 0,
  unitPrice = 0,
}: ProductStockPanelProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch, branches } = useBranches();
  const { formatCurrency } = useCurrency();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const [showOtherBranches, setShowOtherBranches] = useState(false);
  const [editingReorder, setEditingReorder] = useState<string | null>(null);
  const [reorderDraft, setReorderDraft] = useState<string>("");

  // Per-warehouse stock, ALL branches (we filter client-side so we can show
  // "X other branches" disclosure without a second round-trip).
  const { data: rows = [], isLoading } = useQuery<WarehouseStockRow[]>({
    queryKey: ["product-stock-panel", orgId, businessId, productId],
    queryFn: async () => {
      if (!orgId || !businessId || !productId) return [];
      const { data, error } = await supabase
        .from("warehouse_stock")
        .select(
          "id, warehouse_id, branch_id, quantity, reserved_quantity, reorder_level, warehouses(id, name, code, branch_id, is_in_transit), branches:branch_id(id, name)"
        )
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("product_id", productId);
      if (error) throw error;
      return (data || []) as unknown as WarehouseStockRow[];
    },
    enabled: !!orgId && !!businessId && !!productId,
  });

  // Incoming = open PO line quantities not yet received (branch-scoped if active).
  const { data: incoming = 0 } = useQuery<number>({
    queryKey: ["product-incoming", orgId, businessId, branchId, productId],
    queryFn: async () => {
      if (!orgId || !businessId || !productId) return 0;
      let q = supabase
        .from("purchase_order_items")
        .select(
          "quantity, received_quantity, purchase_orders!inner(status, organization_id, business_id, branch_id)"
        )
        .eq("product_id", productId)
        .eq("purchase_orders.organization_id", orgId)
        .eq("purchase_orders.business_id", businessId)
        .in("purchase_orders.status", ["draft", "sent", "partial_received"]);
      if (branchId) q = q.eq("purchase_orders.branch_id", branchId);
      const { data, error } = await q;
      if (error) return 0;
      return (data || []).reduce((sum: number, r: any) => {
        const pending = (r.quantity || 0) - (r.received_quantity || 0);
        return sum + Math.max(0, pending);
      }, 0);
    },
    enabled: !!orgId && !!businessId && !!productId,
  });

  // Recent movement count (cheap badge on the History action).
  const { data: movementCount = 0 } = useQuery<number>({
    queryKey: ["product-movement-count", orgId, businessId, productId],
    queryFn: async () => {
      if (!orgId || !businessId || !productId) return 0;
      const { count } = await supabase
        .from("stock_movements")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("product_id", productId);
      return count ?? 0;
    },
    enabled: !!orgId && !!businessId && !!productId,
  });

  // Slice rows by branch context. is_in_transit warehouses are shown in their
  // own row group regardless of branch (Odoo-style transit location).
  const { activeBranchRows, otherBranchRows, transitRows } = useMemo(() => {
    const active: WarehouseStockRow[] = [];
    const other: WarehouseStockRow[] = [];
    const transit: WarehouseStockRow[] = [];
    for (const r of rows) {
      if (r.warehouses?.is_in_transit) {
        if (r.quantity > 0) transit.push(r);
        continue;
      }
      if (!branchId || r.branch_id === branchId) active.push(r);
      else other.push(r);
    }
    return { activeBranchRows: active, otherBranchRows: other, transitRows: transit };
  }, [rows, branchId]);

  // Canonical availability — branch-scoped headline and company-wide total.
  const { data: availability } = useQuery({
    queryKey: ["stock-availability", productId, businessId, branchId],
    enabled: !!productId && !!businessId,
    queryFn: () =>
      resolveAvailability({ productId, businessId: businessId!, branchId }),
  });
  const { data: companyAvailability } = useQuery({
    queryKey: ["stock-availability", productId, businessId, "company"],
    enabled: !!productId && !!businessId,
    queryFn: () =>
      resolveAvailability({ productId, businessId: businessId!, branchId: null }),
  });



  // Totals — ADR 0142: the branch headline figures come from the canonical
  // server availability engine; the per-warehouse rows below stay a read model.
  const branchOnHand = availability?.onHand ?? 0;
  const branchReserved = availability?.reserved ?? 0;
  const branchAvailable = availability?.available ?? 0;
  const companyOnHand = companyAvailability?.onHand ?? 0;
  const transitQty = availability?.inTransit ?? 0;

  // Forecast = available + incoming. Outgoing is already captured in
  // reserved_quantity (POS holds + sales reservations).
  const forecasted = branchAvailable + (incoming || 0);
  const branchCostValue = branchOnHand * costPrice;
  const branchRetailValue = branchOnHand * unitPrice;

  const scopeLabel = currentBranch?.name
    ? `Branch: ${currentBranch.name}`
    : "All branches";

  const updateReorder = useMutation({
    mutationFn: async ({ rowId, value }: { rowId: string; value: number | null }) => {
      const { error } = await supabase
        .from("warehouse_stock")
        .update({ reorder_level: value })
        .eq("id", rowId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reorder threshold updated");
      queryClient.invalidateQueries({ queryKey: ["product-stock-panel"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock-products"] });
      setEditingReorder(null);
    },
    onError: (err: any) => toast.error("Update failed: " + normalizeError(err).message),
  });

  const adjustHref = `/inventory-app/stock?action=adjust&product=${productId}`;
  const transferHref = `/inventory-app/transfers?action=new&product=${productId}`;
  const receiveHref = `/purchases/orders/new?product=${productId}`;
  const movementsHref = `/inventory-app/stock?tab=movements&product=${productId}`;
  const forecastHref = `/inventory-app/forecast?product=${productId}`;
  const valuationHref = `/inventory-app/reports/valuation?product=${productId}`;

  if (isLoading) {
    return (
      <div className="md:col-span-2 rounded-md border p-6 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderRow = (r: WarehouseStockRow) => {
    const isEditing = editingReorder === r.id;
    const wh = r.warehouses;
    const isLow =
      r.reorder_level != null && r.reorder_level > 0 && r.quantity <= r.reorder_level;
    return (
      <div
        key={r.id}
        className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
      >
        <WarehouseIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-[180px]">
          <div className="font-medium">
            {wh?.name || "Unknown warehouse"}{" "}
            {wh?.code && (
              <span className="text-xs text-muted-foreground">({wh.code})</span>
            )}
          </div>
          {r.branches?.name && !branchId && (
            <div className="text-xs text-muted-foreground">{r.branches.name}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={isLow ? "font-semibold text-warning" : "font-semibold"}>
            {r.quantity}
          </span>
          {r.reserved_quantity > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {r.reserved_quantity} reserved
            </Badge>
          )}
          {isLow && (
            <Badge variant="outline" className="border-warning text-warning text-[10px]">
              Low
            </Badge>
          )}
        </div>
        {isEditing ? (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min="0"
              className="h-7 w-20"
              value={reorderDraft}
              onChange={(e) => setReorderDraft(e.target.value)}
              autoFocus
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={updateReorder.isPending}
              onClick={() => {
                const parsed = reorderDraft.trim() === "" ? null : Number(reorderDraft);
                if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) return;
                updateReorder.mutate({ rowId: r.id, value: parsed });
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setEditingReorder(null)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              setEditingReorder(r.id);
              setReorderDraft(r.reorder_level == null ? "" : String(r.reorder_level));
            }}
          >
            reorder@{r.reorder_level ?? "—"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="md:col-span-2 space-y-4 rounded-md border bg-muted/20 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Stock</h3>
            <Badge variant="secondary" className="text-[10px]">
              {scopeLabel}
            </Badge>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="Why is stock read-only?">
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    Stock totals are derived from movements (receipts, sales,
                    transfers, adjustments) so valuation and the GL stay in
                    sync. Use the actions below to change quantities — never
                    edit a total directly.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {branches.length > 1 && currentBranch && (
            <p className="text-xs text-muted-foreground mt-1">
              Across all branches: <span className="font-medium">{companyOnHand}</span>
              {transitQty > 0 && (
                <>
                  {" "}
                  · in transit: <span className="font-medium">{transitQty}</span>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-md border bg-background p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            On hand
          </p>
          <p className="text-2xl font-bold tabular-nums">{branchOnHand}</p>
        </div>
        <div className="rounded-md border bg-background p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Reserved
          </p>
          <p className="text-2xl font-bold tabular-nums text-warning">
            {branchReserved}
          </p>
        </div>
        <div className="rounded-md border bg-background p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Available
          </p>
          <p className="text-2xl font-bold tabular-nums text-primary">
            {branchAvailable}
          </p>
        </div>
        <div className="rounded-md border bg-background p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            Forecast <TrendingUp className="h-3 w-3" />
          </p>
          <p className="text-2xl font-bold tabular-nums">{forecasted}</p>
          {incoming > 0 && (
            <p className="text-[10px] text-muted-foreground">+{incoming} incoming</p>
          )}
        </div>
      </div>

      {/* Valuation summary (cost basis only — retail is informational) */}
      {(branchCostValue > 0 || branchRetailValue > 0) && (
        <p className="text-xs text-muted-foreground">
          Cost value: <span className="font-medium">{formatCurrency(branchCostValue)}</span>
          {" · "}Retail value:{" "}
          <span className="font-medium">{formatCurrency(branchRetailValue)}</span>
        </p>
      )}

      <Separator />

      {/* Per-warehouse breakdown OR empty state */}
      {activeBranchRows.length === 0 && otherBranchRows.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No stock recorded yet for {productName || "this product"}
            {currentBranch ? ` in ${currentBranch.name}` : ""}.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Link
              to={receiveHref}
              className="flex items-start gap-2 rounded-md border bg-background p-3 hover:bg-accent transition-colors"
            >
              <ArrowDownToLine className="h-4 w-4 text-primary mt-0.5" />
              <div>
                <p className="text-sm font-medium">Receive from supplier</p>
                <p className="text-xs text-muted-foreground">
                  Create a purchase order
                </p>
              </div>
            </Link>
            <Link
              to={adjustHref}
              className="flex items-start gap-2 rounded-md border bg-background p-3 hover:bg-accent transition-colors"
            >
              <PackagePlus className="h-4 w-4 text-primary mt-0.5" />
              <div>
                <p className="text-sm font-medium">Record opening balance</p>
                <p className="text-xs text-muted-foreground">
                  Posts an adjustment at unit cost
                </p>
              </div>
            </Link>
            <Link
              to="/settings/migration"
              className="flex items-start gap-2 rounded-md border bg-background p-3 hover:bg-accent transition-colors"
            >
              <ClipboardEdit className="h-4 w-4 text-primary mt-0.5" />
              <div>
                <p className="text-sm font-medium">Import opening stock</p>
                <p className="text-xs text-muted-foreground">
                  Bulk CSV import
                </p>
              </div>
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            By warehouse{currentBranch ? " (this branch)" : ""}
          </div>
          <div className="space-y-1.5">
            {activeBranchRows.length === 0 && (
              <p className="text-xs text-muted-foreground italic">
                No warehouses in this branch hold stock yet.
              </p>
            )}
            {activeBranchRows.map(renderRow)}
          </div>

          {otherBranchRows.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowOtherBranches((v) => !v)}
                className="text-xs text-primary hover:underline"
              >
                {showOtherBranches ? "Hide" : "Show"} {otherBranchRows.length} warehouse
                {otherBranchRows.length === 1 ? "" : "s"} in other branches
              </button>
              {showOtherBranches && (
                <div className="space-y-1.5 opacity-80">
                  {otherBranchRows.map(renderRow)}
                </div>
              )}
            </>
          )}

          {transitRows.length > 0 && (
            <div className="space-y-1.5 pt-2">
              <div className="text-xs font-medium text-muted-foreground">
                In transit
              </div>
              {transitRows.map(renderRow)}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <Separator />
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="default">
          <Link to={adjustHref}>
            <ClipboardEdit className="h-3.5 w-3.5 mr-1.5" />
            Adjust stock
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={transferHref}>
            <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" />
            Transfer
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={receiveHref}>
            <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />
            Receive (PO)
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={movementsHref}>
            <History className="h-3.5 w-3.5 mr-1.5" />
            Movements
            {movementCount > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">
                {movementCount}
              </Badge>
            )}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={forecastHref}>
            <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
            Forecast
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to={valuationHref}>
            <LineChart className="h-3.5 w-3.5 mr-1.5" />
            Valuation report
          </Link>
        </Button>
      </div>
    </div>
  );
}
