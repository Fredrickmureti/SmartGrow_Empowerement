/**
 * ProductDetailPanel — Product peek surface, composed on the shared
 * design-system `DetailSheet` primitive.
 *
 * Migrated 2026-07-14 from raw `<Sheet>` to `DetailSheet` to (a) align
 * with every other inventory/finance peek (`AdjustmentPeekSheet`,
 * `AssetPeekSheet`, `JournalEntryPeekSheet`) and (b) eliminate the
 * invalid `<div>`-in-`<p>` DOM nesting caused by rendering `<Badge>`
 * inside `<SheetDescription>` (a `<p>` element), which produced
 * horizontal paint tearing on mobile Safari/Chromium during
 * re-renders.
 *
 * Data path: `useProductDetailData` returns immediately after phase 1
 * (product + warehouse_stock + packaging), so the peek paints in one
 * frame. Tab bodies read the deferred slice which loads in parallel.
 *
 * Hook order is unconditional — every `useX(...)` runs before any
 * early return.
 */
import { useMemo } from "react";
import { formatBaseQtyAsPacks, type PackForRollup } from "@/lib/packagingRollup";
import { Link } from "react-router-dom";
import { DetailSheet, FooterActionBar } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentHistoryTab } from "@/components/common/DocumentHistoryTab";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useCurrency } from "@/hooks/useCurrency";
import { useProductDetailData } from "@/hooks/inventory/useProductDetailData";
import {
  ImageIcon,
  Pencil,
  Trash2,
  ClipboardList,
  ArrowRightLeft,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { OverviewTab } from "./tabs/OverviewTab";
import { ProductLifecycleAction } from "./ProductLifecycleAction";
import { productLifecycleLabel } from "@/features/products/lifecycle/productLifecycle";
import { StockTab } from "./tabs/StockTab";
import { LotsExpiryTab } from "./tabs/LotsExpiryTab";
import { UnitsPackagingTab } from "./tabs/UnitsPackagingTab";
import { ValuationTab } from "./tabs/ValuationTab";
import { MovementsTab } from "./tabs/MovementsTab";
import { AccountingTab } from "./tabs/AccountingTab";
import { SuppliersTab } from "./tabs/SuppliersTab";
import { getReplenishmentSignal } from "@/lib/inventory/replenishmentSignal";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string | null;
  /** Optional pre-loaded product (used only for headline while fetch resolves). */
  initialProduct?: { id: string; name: string; sku?: string | null } | null;
  categoryName?: string | null;
  onEdit?: (productId: string) => void;
  onDelete?: (productId: string) => void;
}

export function ProductDetailPanel({
  open,
  onOpenChange,
  productId,
  initialProduct,
  categoryName,
  onEdit,
  onDelete,
}: Props) {
  // ─── Hooks (UNCONDITIONAL) ──────────────────────────────────────────
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { formatCurrency } = useCurrency();

  const branchId = currentBranch?.id ?? null;

  const { data, isLoading } = useProductDetailData({
    productId,
    organizationId: currentOrg?.id,
    businessId: currentBusiness?.id,
    branchId,
    enabled: open,
  });

  // ADR 0142 — on-hand / reserved / available come from the server engine.
  // The browser never sums `warehouse_stock` to reach a decision number.
  const onHand = data?.availability.onHand ?? 0;
  const reserved = data?.availability.reserved ?? 0;
  const available = data?.availability.available ?? 0;


  // ─── Derived values (no hooks beyond here) ──────────────────────────
  const product = data?.product ?? null;
  const headlineName = product?.name ?? initialProduct?.name ?? "Product";
  const headlineSku = product?.sku ?? initialProduct?.sku ?? null;

  const trackInventory: boolean = !!product?.track_inventory;
  const isService = product?.type && product.type !== "product";
  const isLotTracked: boolean = !!product?.is_lot_tracked;
  const isExpiryTracked: boolean = !!product?.is_expiry_tracked;
  const hasMultiUoM = (data?.packaging?.length ?? 0) > 0;
  const hasAccounts =
    !!product?.sales_account_id ||
    !!product?.cogs_account_id ||
    !!product?.inventory_account_id ||
    !!product?.purchase_account_id;
  const hasCost = !!product?.cost_price;

  const reorderLevel = product?.reorder_level ?? 0;
  const isOutOfStock = trackInventory && onHand === 0;
  const isLowStock =
    trackInventory && reorderLevel > 0 && onHand > 0 && onHand <= reorderLevel;
  const isNegative = trackInventory && onHand < 0;

  const tabs = useMemo(() => {
    const all = [
      { id: "overview", label: "Overview", show: true },
      { id: "stock", label: "Stock", show: trackInventory && !isService },
      {
        id: "lots",
        label: "Lots & Expiry",
        show: (isLotTracked || isExpiryTracked) && !isService,
      },
      { id: "units", label: "Units & Packaging", show: hasMultiUoM && !isService },
      {
        id: "valuation",
        label: "Valuation",
        show: trackInventory && hasCost && !isService,
      },
      { id: "movements", label: "Movements", show: trackInventory && !isService },
      { id: "suppliers", label: "Suppliers", show: trackInventory && !isService },
      { id: "accounting", label: "Accounting", show: hasAccounts },
      { id: "activity", label: "Activity", show: true },
    ];
    return all.filter((t) => t.show);
  }, [
    trackInventory,
    isService,
    isLotTracked,
    isExpiryTracked,
    hasMultiUoM,
    hasCost,
    hasAccounts,
  ]);

  const signal = useMemo(
    () =>
      getReplenishmentSignal({
        trackInventory,
        onHand,
        reserved,
        incoming: data?.incomingPo.totalQty ?? 0,
        velocityPerWeek: data?.velocityPerWeek ?? 0,
      }),
    [
      trackInventory,
      onHand,
      reserved,
      data?.incomingPo.totalQty,
      data?.velocityPerWeek,
    ],
  );

  // Description = plain text only (SheetDescription is a <p>; nothing
  // block-level may live inside).
  const description = headlineSku ? `SKU · ${headlineSku}` : undefined;

  const headerActions = product ? (
    <>
      <ProductLifecycleAction
        productId={product.id}
        status={(product as { status?: string | null }).status}
      />

      {onEdit && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Edit product"
          onClick={() => {
            onOpenChange(false);
            onEdit(product.id);
          }}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      {onDelete && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Delete product"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            onOpenChange(false);
            onDelete(product.id);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </>
  ) : undefined;

  // Sticky quick-actions footer — always reachable on mobile without
  // scrolling past the tabs. Only rendered for tracked physical products.
  const footer =
    product && trackInventory && !isService ? (
      <FooterActionBar
        anchor="sheet"
        trailing={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              asChild
              onClick={() => onOpenChange(false)}
            >
              <Link to={`/inventory-app/stock?action=adjust&product=${product.id}`}>
                <ClipboardList className="h-3.5 w-3.5 mr-1" /> Adjust
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              asChild
              onClick={() => onOpenChange(false)}
            >
              <Link to={`/inventory-app/transfers?action=new&product=${product.id}`}>
                <ArrowRightLeft className="h-3.5 w-3.5 mr-1" /> Transfer
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              asChild
              onClick={() => onOpenChange(false)}
            >
              <Link to={`/inventory-app/forecast?product=${product.id}`}>
                <TrendingUp className="h-3.5 w-3.5 mr-1" /> Forecast
              </Link>
            </Button>
            <Button
              size="sm"
              asChild
              onClick={() => onOpenChange(false)}
              className={
                isLowStock || isOutOfStock
                  ? "bg-warning text-warning-foreground hover:bg-warning/90"
                  : ""
              }
            >
              <Link to={`/purchases/orders/new?product=${product.id}`}>
                <ShoppingCart className="h-3.5 w-3.5 mr-1" />{" "}
                {isLowStock || isOutOfStock ? "Replenish" : "Create PO"}
              </Link>
            </Button>
          </div>
        }
      />
    ) : undefined;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">{headlineName}</span>
        </span>
      }
      description={description}
      headerActions={headerActions}
      footer={footer}
    >
      {/* Product thumbnail + status badges (rendered in the body, NOT inside
          SheetDescription — badges are <div> and would invalidate the <p>). */}
      <div className="flex items-start gap-3 -mt-1">
        <div className="h-14 w-14 rounded-md border bg-muted overflow-hidden flex items-center justify-center shrink-0">
          {product?.image_url ? (
            <img
              src={product.image_url}
              alt={headlineName}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {product && (
            <>
              <Badge variant="outline" className="capitalize text-xs">
                {product.type}
              </Badge>
              {((product as { status?: string | null }).status ?? "active") !== "active" && (
                <Badge variant="secondary" className="text-xs">
                  {productLifecycleLabel((product as { status?: string | null }).status)}
                </Badge>
              )}
              {isOutOfStock && (
                <Badge variant="destructive" className="text-xs">
                  Out of stock
                </Badge>
              )}
              {isLowStock && (
                <Badge className="bg-warning/15 text-warning border border-warning/30 text-xs">
                  Low stock
                </Badge>
              )}
              {isNegative && (
                <Badge variant="destructive" className="text-xs">
                  Negative stock
                </Badge>
              )}
              {isLotTracked && (
                <Badge variant="outline" className="text-xs">
                  Lot-tracked
                </Badge>
              )}
              {isExpiryTracked && (
                <Badge variant="outline" className="text-xs">
                  Expiry
                </Badge>
              )}
              {hasMultiUoM && (
                <Badge variant="outline" className="text-xs">
                  Multi-UoM
                </Badge>
              )}
            </>
          )}
        </div>
      </div>

      {isLoading && !product ? (
        <div className="space-y-3 mt-6">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !product || !data ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Product not found.
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {/* Intelligence strip */}
          {trackInventory &&
            !isService &&
            (() => {
              const baseLabel = (product as any).unit_of_measure ?? "ea";
              const packs: PackForRollup[] = (data.packaging ?? []).map(
                (pk: any) => ({
                  name: pk.name,
                  qty_in_base_uom: Number(pk.qty_in_base_uom),
                }),
              );
              const fmt = (n: number) => {
                const base = `${Number(n.toFixed(3))} ${baseLabel}`;
                if (packs.length === 0 || n <= 0) return base;
                const pk = formatBaseQtyAsPacks(n, packs, baseLabel);
                return pk === base ? base : pk;
              };
              return (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <StatCard
                    label={`On hand${currentBranch ? ` · ${currentBranch.name}` : ""}`}
                    value={fmt(onHand)}
                    sub={
                      packs.length > 0 && onHand > 0
                        ? `${Number(onHand.toFixed(3))} ${baseLabel}`
                        : undefined
                    }
                    tone={
                      isNegative
                        ? "destructive"
                        : isOutOfStock
                          ? "destructive"
                          : isLowStock
                            ? "warning"
                            : "default"
                    }
                  />
                  <StatCard label="Reserved" value={fmt(reserved)} />
                  <StatCard
                    label="Available"
                    value={fmt(available)}
                    tone={available < 0 ? "destructive" : "default"}
                  />
                  <StatCard
                    label="Value"
                    value={formatCurrency(
                      onHand * Number(product.cost_price ?? 0),
                    )}
                  />
                </div>
              );
            })()}

          {(data.incomingPo.totalQty > 0 ||
            data.velocityPerWeek > 0 ||
            signal.tier !== "untracked") && (
            <div className="flex flex-wrap gap-2 text-xs">
              {trackInventory &&
                !isService &&
                signal.tier !== "no-velocity" &&
                signal.tier !== "untracked" && (
                  <Badge
                    variant="outline"
                    title={signal.hint}
                    className={
                      "font-normal " +
                      (signal.tone === "destructive"
                        ? "border-destructive/40 text-destructive"
                        : signal.tone === "warning"
                          ? "border-warning/40 text-warning"
                          : signal.tone === "success"
                            ? "border-success/40 text-success"
                            : "")
                    }
                  >
                    {signal.label}
                  </Badge>
                )}
              {data.incomingPo.totalQty > 0 && (
                <Badge variant="outline" className="font-normal">
                  {data.incomingPo.totalQty} incoming ·{" "}
                  {data.incomingPo.openOrders} PO
                  {data.incomingPo.openOrders === 1 ? "" : "s"}
                </Badge>
              )}
              {data.velocityPerWeek > 0 && (
                <Badge variant="outline" className="font-normal">
                  {data.velocityPerWeek.toFixed(1)} / week sold
                </Badge>
              )}
            </div>
          )}

          {/* Quick actions moved to sticky FooterActionBar (anchor="sheet")
              so they remain reachable on mobile without scrolling. */}



          {/* Tabs */}
          <Tabs defaultValue={tabs[0]?.id ?? "overview"}>
            <TabsList className="flex flex-wrap h-auto">
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="text-xs">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="overview">
              <OverviewTab data={data} categoryName={categoryName} />
            </TabsContent>
            <TabsContent value="stock">
              <StockTab data={data} />
            </TabsContent>
            <TabsContent value="lots">
              <LotsExpiryTab data={data} />
            </TabsContent>
            <TabsContent value="units">
              <UnitsPackagingTab data={data} />
            </TabsContent>
            <TabsContent value="valuation">
              <ValuationTab data={data} onHand={onHand} />
            </TabsContent>
            <TabsContent value="movements">
              <MovementsTab data={data} />
            </TabsContent>
            <TabsContent value="suppliers">
              <SuppliersTab
                productId={product.id}
                baseLabel={(product as any).unit_of_measure ?? "ea"}
                packs={(data.packaging ?? []).map((pk: any) => ({
                  name: pk.name,
                  qty_in_base_uom: Number(pk.qty_in_base_uom),
                }))}
              />
            </TabsContent>
            <TabsContent value="accounting">
              <AccountingTab data={data} />
            </TabsContent>
            <TabsContent value="activity">
              <div className="pt-2">
                <DocumentHistoryTab
                  entityType="product"
                  entityId={product.id}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </DetailSheet>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warning" | "destructive";
}) {
  const toneClass =
    tone === "destructive"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning"
        : "";
  return (
    <div className="rounded-md border p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`text-base font-semibold leading-tight ${toneClass}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
