/**
 * InvoiceLineRow — the invoice line editor, rendered inside the platform
 * `EditableLineItemsGrid` (design-system/records).
 *
 * Phase 8: this used to be a `<TableRow>` for the desktop table, with the
 * Create page duplicating every field again as a mobile card. Both are
 * gone. The row now renders into the grid's measured layout: whichever
 * columns the container can hold sit on the primary line, the rest are
 * demoted to a labelled secondary line by the grid — still editable.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers, keep
 * `products` / `linesCount` / `headerProjectId` references constant within
 * a render cycle) or the memo will not engage, and the rapid-scan workflow
 * (>60 scans/min) loses its O(1)-per-scan render guarantee.
 */

import { memo } from "react";
import { Input } from "@/components/ui/input";
import { ProductCombobox } from "@/components/common/ProductCombobox";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  StockBadge,
  StockLineStatus,
} from "@/components/inventory/StockAvailabilityIndicator";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { PackagingSelect } from "@/components/products/PackagingSelect";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";
import {
  lotNumberFromAllocations,
  serialNumberFromRows,
} from "@/components/inventory/outboundLineTrackingUtils";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

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
  // Phase A.4 — picker output persisted to invoice_items.
  lot_number?: string | null;
  serial_number?: string | null;
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

/**
 * Column contract for the invoice line grid. Shared verbatim by the Create
 * and Edit pages so the two surfaces can never drift.
 */
export const INVOICE_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "item", header: "Item", priority: 1, minWidth: 240 },
  { id: "quantity", header: "Qty", priority: 2, minWidth: 110, compactLabel: "Qty" },
  { id: "unit_price", header: "Price", priority: 2, minWidth: 110, numeric: true, compactLabel: "Price" },
  { id: "tax_rate", header: "Tax %", priority: 3, minWidth: 90, numeric: true, compactLabel: "Tax %" },
  { id: "line_total", header: "Total", priority: 1, minWidth: 110, numeric: true },
];

interface StockEval {
  product: InvoiceLineRowProduct;
}

interface Props {
  index: number;
  item: InvoiceLineItemShape;
  products: InvoiceLineRowProduct[];
  /** Layout resolved by `EditableLineItemsGrid` for the measured container. */
  layout: EditableRowLayout;
  flashed: boolean;
  isSubmitting?: boolean;
  /** Optional — when present the row renders stock status. */
  stockEval?: StockEval | null;
  /** Optional — when present the row renders the analytics cell. */
  headerProjectId?: string | null;
  customerId?: string | null;
  formatCurrency: (n: number) => string;
  onProductSelect: (index: number, productId: string) => void;
  onUpdate: (index: number, patch: Partial<InvoiceLineItemShape>) => void;
}

function InvoiceLineRowInner({
  index,
  item,
  products,
  layout,
  flashed,
  isSubmitting,
  stockEval,
  headerProjectId,
  customerId,
  formatCurrency,
  onProductSelect,
  onUpdate,
}: Props) {
  const cell = (columnId: string) => {
    switch (columnId) {
      case "item":
        return (
          <div className="min-w-0 space-y-2">
            <ProductCombobox
              products={products}
              value={item.product_id || ""}
              onChange={(value) => onProductSelect(index, value)}
              disabled={isSubmitting}
              formatCurrency={formatCurrency}
              className="w-full min-w-0"
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
              disabled={isSubmitting}
            />
          </div>
        );

      case "quantity":
        return (
          <div className="space-y-1">
            <NumericInput
              value={item.display_quantity ?? item.quantity}
              disabled={isSubmitting}
              onValueChange={(v) => {
                const qty = v ?? 0;
                // When sold in packs, `quantity` (base units) = pack qty × pack
                // size. The DB trigger also normalizes server-side; we mirror
                // here for accurate live totals.
                onUpdate(index, {
                  display_quantity: item.packaging_id ? qty : null,
                  quantity:
                    item.packaging_id && item.display_quantity != null
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
        );

      case "unit_price":
        return (
          <NumericInput
            value={item.unit_price}
            disabled={isSubmitting}
            onValueChange={(v) => onUpdate(index, { unit_price: v ?? 0 })}
            className="h-8"
          />
        );

      case "tax_rate":
        return (
          <NumericInput
            value={item.tax_rate}
            disabled={isSubmitting}
            onValueChange={(v) => onUpdate(index, { tax_rate: v ?? 0 })}
            className="h-8"
          />
        );

      case "line_total":
        return (
          <div className="pt-2 text-right font-medium tabular-nums">
            {formatCurrency(item.line_total)}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <EditableLineRowCells
      layout={layout}
      flashed={flashed}
      cell={cell}
      extra={
        <>
          {stockEval && (
            <StockLineStatus
              trackInventory={stockEval.product.track_inventory ?? undefined}
              productType={stockEval.product.type ?? undefined}
              onHand={
                (stockEval.product.available ?? stockEval.product.stock_quantity) ??
                undefined
              }
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
            onLotChange={(allocs) =>
              onUpdate(index, { lot_number: lotNumberFromAllocations(allocs) })
            }
            onSerialChange={(_ids, rows) =>
              onUpdate(index, { serial_number: serialNumberFromRows(rows) })
            }
          />
        </>
      }
    />
  );
}

export const InvoiceLineRow = memo(InvoiceLineRowInner) as typeof InvoiceLineRowInner;
