/**
 * InvoiceLineRow — memoized row used by Create / Edit invoice dialogs'
 * desktop tables. Extracted so a scan-driven `setLineItems` only
 * re-renders the affected row instead of the entire dialog form.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers,
 * keep `products`/`linesCount`/`headerProjectId` references constant
 * within a render cycle) or the memo will not engage.
 */

import { memo } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductCombobox } from "@/components/common/ProductCombobox";
import {
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  StockBadge,
  StockLineStatus,
} from "@/components/inventory/StockAvailabilityIndicator";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { PackagingSelect } from "@/components/products/PackagingSelect";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";

export interface InvoiceLineItemShape {
  product_id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount?: number;
  discount_percent?: number;
  line_total: number;
  sort_order?: number;
  project_id?: string | null;
  task_id?: string | null;
  // Phase B UoM provenance — `quantity` is ALWAYS base units; these record
  // what the operator actually entered ("3 cartons of 12").
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

export interface InvoiceLineRowProduct {
  id: string;
  name: string;
  unit_price: number;
  tax_rate?: number;
  track_inventory?: boolean | null;
  type?: string | null;
  stock_quantity?: number | null;
  reorder_level?: number | null;
  available?: number | null;
}

interface StockEval {
  product: InvoiceLineRowProduct;
}

interface Props {
  index: number;
  item: InvoiceLineItemShape;
  products: InvoiceLineRowProduct[];
  linesCount: number;
  flashed: boolean;
  isSubmitting?: boolean;
  /** Optional — when present the row renders stock status. */
  stockEval?: StockEval | null;
  /** Optional — when present the row renders the analytics cell. */
  headerProjectId?: string | null;
  customerId?: string | null;
  /** Compact = Edit dialog (no truncation classes / no min-width); else Create. */
  variant?: "compact" | "rich";
  formatCurrency: (n: number) => string;
  onProductSelect: (index: number, productId: string) => void;
  onUpdate: (index: number, patch: Partial<InvoiceLineItemShape>) => void;
  onRemove: (index: number) => void;
}

function InvoiceLineRowInner({
  index, item, products, linesCount, flashed, isSubmitting,
  stockEval, headerProjectId, customerId, variant = "rich",
  formatCurrency, onProductSelect, onUpdate, onRemove,
}: Props) {
  const rich = variant === "rich";
  return (
    <TableRow className={cn(flashed && "bg-primary/10 transition-colors")}>
      <TableCell className={rich ? "w-[300px] max-w-[300px] min-w-0" : undefined}>
        <div className={rich ? "min-w-0 space-y-2" : "space-y-2"}>
          <ProductCombobox
            products={products}
            value={item.product_id || ""}
            onChange={(value) => onProductSelect(index, value)}
            disabled={isSubmitting}
            formatCurrency={formatCurrency}
            className={cn(rich && "w-full min-w-0")}
            renderItemRight={(p) => (
              <StockBadge
                trackInventory={p.track_inventory ?? undefined}
                productType={p.type ?? undefined}
                onHand={(p.available ?? p.stock_quantity) ?? undefined}
                reorderLevel={p.reorder_level ?? undefined}
              />
            )}
          />
          <Input
            placeholder="Description"
            value={item.description}
            onChange={(e) => onUpdate(index, { description: e.target.value })}
            className="h-8"
          />
          {stockEval && (
            <StockLineStatus
              trackInventory={stockEval.product.track_inventory ?? undefined}
              productType={stockEval.product.type ?? undefined}
              onHand={(stockEval.product.available ?? stockEval.product.stock_quantity) ?? undefined}
              reorderLevel={stockEval.product.reorder_level ?? undefined}
              requestedQty={item.quantity}
            />
          )}
          <LineAnalyticsCell
            projectId={item.project_id ?? null}
            taskId={item.task_id ?? null}
            headerProjectId={headerProjectId ?? null}
            customerId={customerId ?? null}
            onChange={(next) => onUpdate(index, next)}
            disabled={!!isSubmitting}
          />
          <OutboundLineTracking
            productId={item.product_id ?? null}
            quantity={item.quantity}
          />
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <NumericInput
            value={item.display_quantity ?? item.quantity}
            onValueChange={(v) => {
              const qty = v ?? 0;
              // When sold in packs, `quantity` (base units) = pack qty × pack size.
              // The DB trigger also normalizes server-side; we mirror here for
              // accurate live totals.
              onUpdate(index, {
                display_quantity: item.packaging_id ? qty : null,
                quantity: item.packaging_id && item.display_quantity != null
                  ? qty * (item.quantity / Math.max(item.display_quantity, 1))
                  : qty,
              });
            }}
            className="h-8"
          />
          <PackagingSelect
            productId={item.product_id ?? null}
            value={item.packaging_id ?? null}
            onChange={(pkgId, packQty) => {
              if (!pkgId) {
                onUpdate(index, {
                  packaging_id: null,
                  display_uom_id: null,
                  display_quantity: null,
                });
                return;
              }
              const dq = item.display_quantity ?? 1;
              // `display_uom_id` is left null on purpose — the server trigger
              // defaults it to the product's base UoM. Packaging carries no
              // UoM column of its own; the pack multiplier IS the conversion.
              onUpdate(index, {
                packaging_id: pkgId,
                display_uom_id: null,
                display_quantity: dq,
                quantity: dq * (packQty ?? 1),
              });
            }}
            className="h-7 text-xs"
          />

        </div>
      </TableCell>
      <TableCell>
        <NumericInput
          value={item.unit_price}
          onValueChange={(v) => onUpdate(index, { unit_price: v ?? 0 })}
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <NumericInput
          value={item.tax_rate}
          onValueChange={(v) => onUpdate(index, { tax_rate: v ?? 0 })}
          className="h-8"
        />
      </TableCell>
      <TableCell className="text-right font-medium">
        {formatCurrency(item.line_total)}
      </TableCell>
      <TableCell>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onRemove(index)}
          disabled={linesCount === 1}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export const InvoiceLineRow = memo(InvoiceLineRowInner) as typeof InvoiceLineRowInner;
