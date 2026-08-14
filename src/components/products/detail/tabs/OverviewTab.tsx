/**
 * OverviewTab — answers the five canonical product-intelligence questions
 * in order, adapting to the product's actual configuration:
 *   1. What is this product?
 *   2. How much do we have?
 *   3. How is it tracked?
 *   4. What is it worth?
 *   5. Does it need attention?
 *
 * Compliance (ETIMS / origin / HS code) is collapsed at the bottom so the
 * scannable answers stay above the fold.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useCurrency } from "@/hooks/useCurrency";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import {
  formatQtyWithPacks,
  type PackForRollup,
} from "@/lib/inventory/formatQty";
import { getReplenishmentSignal } from "@/lib/inventory/replenishmentSignal";
import { getProductBadges, PRODUCT_BADGE_META } from "@/hooks/inventory/useProductBadges";
import {
  Hash,
  FolderTree,
  Tag,
  Percent,
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Activity,
  Warehouse,
  ChevronDown,
  ChevronUp,
  Globe,
  Barcode,
} from "lucide-react";

interface Props {
  data: ProductDetailData;
  categoryName?: string | null;
}

export function OverviewTab({ data, categoryName }: Props) {
  const { formatCurrency } = useCurrency();
  const [showCompliance, setShowCompliance] = useState(false);
  const p = data.product;
  if (!p) return null;

  const trackInventory: boolean = !!p.track_inventory;
  const isService = p.type && p.type !== "product";
  const baseLabel = (p as any).unit_of_measure ?? "ea";
  const packs: PackForRollup[] = (data.packaging ?? []).map((pk: any) => ({
    name: pk.name,
    qty_in_base_uom: Number(pk.qty_in_base_uom),
  }));

  // Totals
  const onHand = (data.warehouseStock ?? []).reduce(
    (s: number, ws: any) => s + (Number(ws.quantity) || 0),
    0,
  );
  const reserved = (data.warehouseStock ?? []).reduce(
    (s: number, ws: any) => s + (Number(ws.reserved_quantity) || 0),
    0,
  );
  const available = onHand - reserved;
  const incoming = data.incomingPo.totalQty;

  // Top warehouse
  const topWarehouse = [...(data.warehouseStock ?? [])]
    .sort((a: any, b: any) => Number(b.quantity || 0) - Number(a.quantity || 0))[0];

  // Replenishment signal
  const signal = getReplenishmentSignal({
    trackInventory,
    onHand,
    reserved,
    incoming,
    velocityPerWeek: data.velocityPerWeek,
  });

  // Margin / profit
  const margin =
    p.cost_price && p.cost_price > 0 && p.unit_price > 0
      ? ((p.unit_price - p.cost_price) / p.unit_price) * 100
      : null;
  const profit = p.cost_price ? p.unit_price - p.cost_price : null;
  const costValue = onHand * Number(p.cost_price ?? 0);
  const retailValue = onHand * Number(p.unit_price ?? 0);

  // Tracking chips
  const badges = getProductBadges(p, (data.packaging?.length ?? 0) > 0);

  // Base barcodes (no packaging_id)
  const baseBarcodes = (data.identifiers ?? [])
    .filter((id: any) => !id.packaging_id && id.code)
    .map((id: any) => id.code as string);

  // Attention items
  const expiringSoon = (data.warehouseStockLots ?? []).filter((l: any) => {
    if (!l.expiry_date) return false;
    const days =
      (new Date(l.expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return days >= 0 && days <= (p.expiry_alert_days ?? 30);
  }).length;
  const isNegative = trackInventory && onHand < 0;

  const fmtQty = (n: number) => formatQtyWithPacks(n, packs, baseLabel);

  // Compliance fields actually present in schema
  const hasCompliance =
    !!(p as any).etims_item_code ||
    !!(p as any).etims_classification_code ||
    !!(p as any).etims_unit_code ||
    !!(p as any).etims_packaging_unit ||
    !!(p as any).etims_origin_country ||
    !!(p as any).etims_country_origin;

  return (
    <div className="space-y-4 pt-2">
      {p.description && (
        <p className="text-sm text-muted-foreground">{p.description}</p>
      )}

      {/* 5. Does it need attention? (top — only renders when there is something) */}
      {trackInventory && !isService && (signal.tier !== "healthy" && signal.tier !== "no-velocity" || isNegative || expiringSoon > 0) && (
        <div className="space-y-2">
          {signal.tier !== "healthy" && signal.tier !== "no-velocity" && (
            <AttentionRow tone={signal.tone} text={`${signal.label} — ${signal.hint}`} />
          )}
          {isNegative && (
            <AttentionRow
              tone="destructive"
              text="Negative on-hand — a sale or transfer drew more than received. Reconcile before next receipt."
            />
          )}
          {expiringSoon > 0 && (
            <AttentionRow
              tone="warning"
              text={`${expiringSoon} lot${expiringSoon === 1 ? "" : "s"} expiring soon — see the Lots & Expiry tab.`}
            />
          )}
        </div>
      )}

      {/* 1. What is this product? */}
      <Section title="Identification">
        <Row icon={Hash} label="SKU" value={p.sku || "—"} />
        {categoryName && (
          <Row
            icon={FolderTree}
            label="Category"
            value={<Badge variant="secondary" className="text-xs">{categoryName}</Badge>}
          />
        )}
        <Row icon={Tag} label="Type" value={<span className="capitalize">{p.type}</span>} />
        {!isService && (
          <Row icon={Warehouse} label="Base unit" value={baseLabel} />
        )}
        {baseBarcodes.length > 0 && (
          <Row
            icon={Barcode}
            label="Barcode"
            value={<span className="font-mono text-xs">{baseBarcodes.join(", ")}</span>}
          />
        )}
      </Section>

      {/* 2. How much do we have? */}
      {trackInventory && !isService && (
        <>
          <Separator />
          <Section title="Availability">
            <Row icon={Activity} label="On hand" value={fmtQty(onHand)} />
            <Row icon={Activity} label="Reserved" value={reserved > 0 ? fmtQty(reserved) : "—"} />
            <Row
              icon={Activity}
              label="Available"
              value={
                <span className={available < 0 ? "text-destructive font-semibold" : "font-semibold"}>
                  {fmtQty(available)}
                </span>
              }
            />
            {incoming > 0 && (
              <Row
                icon={TrendingUp}
                label={`Incoming (${data.incomingPo.openOrders} PO${data.incomingPo.openOrders === 1 ? "" : "s"})`}
                value={fmtQty(incoming)}
              />
            )}
            {topWarehouse && (
              <Row
                icon={Warehouse}
                label="Top warehouse"
                value={
                  <span className="text-sm">
                    {(topWarehouse as any).warehouses?.name ?? "—"}{" "}
                    <span className="text-muted-foreground">
                      · {fmtQty(Number((topWarehouse as any).quantity || 0))}
                    </span>
                  </span>
                }
              />
            )}
            {data.velocityPerWeek > 0 && (
              <Row
                icon={TrendingUp}
                label="Velocity"
                value={
                  <span className="text-sm">
                    {data.velocityPerWeek.toFixed(1)} {baseLabel}/week
                    {signal.daysOfSupply != null && (
                      <span className="text-muted-foreground">
                        {" "}· {Math.round(signal.daysOfSupply)}d cover
                      </span>
                    )}
                  </span>
                }
              />
            )}
          </Section>
        </>
      )}

      {/* 3. How is it tracked? */}
      {badges.length > 0 && (
        <>
          <Separator />
          <Section title="Tracking">
            <div className="flex flex-wrap gap-1.5">
              {badges.map((b) => {
                const meta = PRODUCT_BADGE_META[b];
                return (
                  <Badge key={b} variant={meta.tone} title={meta.title} className="text-xs">
                    {meta.label}
                  </Badge>
                );
              })}
            </div>
          </Section>
        </>
      )}

      {/* 4. What is it worth? */}
      <Separator />
      <Section title="Pricing & value">
        <Row icon={DollarSign} label={`Unit price (per ${baseLabel})`} value={formatCurrency(p.unit_price)} />
        <Row icon={DollarSign} label={`Cost price (per ${baseLabel})`} value={p.cost_price ? formatCurrency(p.cost_price) : "—"} />
        {profit !== null && (
          <Row
            icon={profit >= 0 ? TrendingUp : TrendingDown}
            label="Profit / unit"
            value={
              <span className={profit >= 0 ? "text-success" : "text-destructive"}>
                {formatCurrency(profit)}
              </span>
            }
          />
        )}
        {margin !== null && (
          <Row
            icon={Percent}
            label="Margin"
            value={
              <span className={margin >= 0 ? "text-success" : "text-destructive"}>
                {margin.toFixed(1)}%
              </span>
            }
          />
        )}
        {trackInventory && !isService && p.cost_price && (
          <>
            <Row icon={DollarSign} label="Total cost value" value={formatCurrency(costValue)} />
            <Row icon={DollarSign} label="Total retail value" value={formatCurrency(retailValue)} />
          </>
        )}
        <Row icon={Percent} label="Tax rate" value={p.tax_rate ? `${p.tax_rate}%` : "—"} />
      </Section>

      {/* Compliance — collapsible */}
      {hasCompliance && (
        <>
          <Separator />
          <button
            type="button"
            onClick={() => setShowCompliance((s) => !s)}
            className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider"
          >
            <span className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" /> Compliance
            </span>
            {showCompliance ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {showCompliance && (
            <div className="pt-1">
              {loc?.item_code && (
                <Row icon={Hash} label="Fiscal item code" value={<span className="font-mono text-xs">{loc.item_code}</span>} />
              )}
              {loc?.classification_code && (
                <Row icon={Hash} label="Classification" value={<span className="font-mono text-xs">{loc.classification_code}</span>} />
              )}
              {loc?.unit_code && <Row icon={Tag} label="Fiscal unit" value={loc.unit_code} />}
              {loc?.packaging_unit && <Row icon={Tag} label="Packaging unit" value={loc.packaging_unit} />}
              {loc?.origin_country && (
                <Row icon={Globe} label="Country of origin" value={loc.origin_country} />
              )}
            </div>
          )}

        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{title}</h4>
      {children}
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_1fr_1fr] gap-3 items-start py-1.5">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5" />
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function AttentionRow({
  tone,
  text,
}: {
  tone: "default" | "success" | "warning" | "destructive";
  text: string;
}) {
  const toneClass =
    tone === "destructive"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : tone === "warning"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-border bg-muted/40";
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
