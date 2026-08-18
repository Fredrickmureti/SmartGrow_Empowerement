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
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import type { PricedLineUnits } from "@/components/documents/lines/PricedLineRow";
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
import type { LineStockEval } from "@/features/sales/availability";

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

/**
 * Stock status is described by ONE declaration, `LineStockEval` from
 * `@/features/sales/availability` (Phase 5 contract). This row must not
 * re-declare a narrower/wider shape: doing so is what let the invoice pages
 * and the row disagree about which product fields a stock badge needs.
 */

interface Props {
  index: number;
  item: InvoiceLineItemShape;
  products: InvoiceLineRowProduct[];
  /** Layout resolved by `EditableLineItemsGrid` for the measured container. */
  layout: EditableRowLayout;
  flashed: boolean;
  isSubmitting?: boolean;
  /** Optional — when present the row renders stock status. */
  stockEval?: LineStockEval | null;
  /** Optional — when present the row renders the analytics cell. */
  headerProjectId?: string | null;
  customerId?: string | null;
  formatCurrency: (n: number) => string;
  onProductSelect: (index: number, productId: string) => void;
  onUpdate: (index: number, patch: Partial<InvoiceLineItemShape>) => void;
  /**
   * Supplies the units the product may be sold in. MUST be `useCallback`-stable.
   */
  unitsFor?: (productId: string | null | undefined) => PricedLineUnits | null;
  /**
   * Warehouse the document issues stock from (`invoices.warehouse_id`). The
   * lot/serial pickers MUST resolve availability against this warehouse — the
   * branch default is only a fallback and is frequently unset.
   */
  warehouseId?: string | null;
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
  unitsFor,
  warehouseId,

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
        {
        const units = unitsFor?.(item.product_id) ?? null;
        return (
          // ONE quantity cell across every document. `quantity` stays base
          // units; the server trigger (_uom_normalize_line →
          // resolve_line_base_quantity) is the authority, this is a preview.
          <PackagedQtyCell
            productId={item.product_id ?? null}
            value={item}
            onChange={(patch) => onUpdate(index, patch)}
            disabled={isSubmitting}
            baseUomId={units?.baseUomId ?? null}
            uomOptions={units?.options}
          />
        );
        }

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
        // Alignment comes from the grid (numeric columns are right-aligned on
        // the primary line, left on the demoted line) — do not force it here.
        return (
          <div className="font-medium tabular-nums">
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
            warehouseId={warehouseId ?? null}

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
