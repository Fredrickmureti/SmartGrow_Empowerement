/**
 * PricedLineRow — the ONE priced line editor for sales documents that carry
 * item / qty / price / tax / total (Estimate, Proforma, Sales Order, Credit
 * Note, Return …).
 *
 * Phase 8 of the document-workspace consolidation. Each of these forms used
 * to ship its own `grid-cols-12` (or `<Table>`) line editor plus, in several
 * cases, a duplicated `sm:hidden` card stack. They drifted field by field.
 * This row renders into the measured layout of the platform
 * `EditableLineItemsGrid`: whichever columns the container can hold sit on
 * the primary line, the rest are demoted onto a labelled secondary line —
 * still editable — instead of forcing a horizontal scrollbar.
 *
 * The Invoice keeps its own row (`components/invoices/InvoiceLineRow`)
 * because it additionally renders stock status, analytic tagging and
 * lot/serial pickers. Both rows share this grid and its measurement engine.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers) or the
 * memo will not engage.
 */

import { memo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { ProductCombobox, type ProductOption } from "@/components/common/ProductCombobox";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import { StockLineStatus } from "@/components/inventory/StockAvailabilityIndicator";
import type { LineStockEval } from "@/features/sales/availability";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

/** Minimum line shape every priced sales document satisfies. */
export interface PricedLineShape {
  product_id?: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate?: number;
  tax_amount?: number;
  line_total?: number;
  // UoM provenance — `quantity` is ALWAYS base units.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

/** Column contract shared by every priced sales line editor. */
export const PRICED_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "item", header: "Item", priority: 1, minWidth: 240 },
  { id: "quantity", header: "Qty", priority: 2, minWidth: 110, compactLabel: "Qty" },
  {
    id: "unit_price",
    header: "Price",
    priority: 2,
    minWidth: 110,
    numeric: true,
    compactLabel: "Price",
  },
  {
    id: "tax_rate",
    header: "Tax %",
    priority: 3,
    minWidth: 90,
    numeric: true,
    compactLabel: "Tax %",
  },
  { id: "line_total", header: "Total", priority: 1, minWidth: 110, numeric: true },
];

/** Same contract without the tax column (documents that tax at header level). */
export const PRICED_LINE_COLUMNS_NO_TAX = PRICED_LINE_COLUMNS.filter(
  (c) => c.id !== "tax_rate",
);

export type PricedLineRowProduct = ProductOption & { tax_rate?: number | null };

/** Sell-unit options for a product, resolved by the parent form. */
export interface PricedLineUnits {
  baseUomId: string | null;
  options: import("@/hooks/useSellableUnits").SellUnitOption[];
}

interface Props<T extends PricedLineShape> {
  index: number;
  item: T;
  /** Omit together with `hideProductPicker` for documents with no catalogue picker. */
  products?: PricedLineRowProduct[];
  /** Renders the item cell as a bare description input (credit notes, returns). */
  hideProductPicker?: boolean;
  /**
   * Column ids rendered as read-only text instead of inputs. Used by documents
   * whose lines carry provenance from a source document (a credit note line
   * picked off an invoice must not have its item, price or tax retyped).
   */
  lockedCells?: string[];
  /** Layout resolved by `EditableLineItemsGrid` for the measured container. */
  layout: EditableRowLayout;
  disabled?: boolean;
  flashed?: boolean;
  formatCurrency: (n: number) => string;
  /** Applies a partial update to the line. */
  onPatch: (index: number, patch: Partial<T>) => void;
  /**
   * Product selection. Defaults to a plain `product_id` patch — pass this
   * when the form derives description / price / tax from the product.
   */
  onProductSelect?: (index: number, productId: string) => void;
  /** Rendered full width beneath the row (analytics, tracking, reasons). */
  extra?: ReactNode;
  productPlaceholder?: string;
  /**
   * Supplies the units a product may be sold in. Omit for documents that
   * only ever transact in the stocking unit. MUST be `useCallback`-stable.
   */
  unitsFor?: (productId: string | null | undefined) => PricedLineUnits | null;
  /**
   * Per-line stock evaluation from `useSalesLineAvailability`. Renders the
   * inline availability status beneath the row. Omit for documents whose
   * stock policy is `none` (credit notes, returns).
   */
  stockEval?: LineStockEval | null;
}

function PricedLineRowInner<T extends PricedLineShape>({
  index,
  item,
  products,
  hideProductPicker,
  lockedCells,
  layout,
  disabled,
  flashed,
  formatCurrency,
  onPatch,
  onProductSelect,
  extra,
  productPlaceholder,
  unitsFor,
  stockEval,
}: Props<T>) {
  const isLocked = (columnId: string) => lockedCells?.includes(columnId) ?? false;

  const cell = (columnId: string) => {
    switch (columnId) {
      case "item":
        if (isLocked("item")) {
          return (
            <div className="min-w-0 pt-2 text-sm font-medium">
              {item.description || "—"}
            </div>
          );
        }
        if (hideProductPicker) {
          return (
            <Input
              placeholder="Description"
              value={item.description}
              onChange={(e) =>
                onPatch(index, { description: e.target.value } as Partial<T>)
              }
              className="h-8"
              disabled={disabled}
            />
          );
        }
        return (
          <div className="min-w-0 space-y-2">
            <ProductCombobox
              products={products ?? []}
              value={item.product_id || ""}
              onChange={(value) =>
                onProductSelect
                  ? onProductSelect(index, value)
                  : onPatch(index, { product_id: value } as Partial<T>)
              }
              disabled={disabled}
              formatCurrency={formatCurrency}
              placeholder={productPlaceholder}
              className="w-full min-w-0"
            />
            <Input
              placeholder="Description"
              value={item.description}
              onChange={(e) =>
                onPatch(index, { description: e.target.value } as Partial<T>)
              }
              className="h-8"
              disabled={disabled}
            />
          </div>
        );

      case "quantity":
        {
        const units = unitsFor?.(item.product_id) ?? null;
        return (
          <PackagedQtyCell
            productId={item.product_id ?? null}
            value={item}
            onChange={(patch) => onPatch(index, patch as Partial<T>)}
            disabled={disabled}
            baseUomId={units?.baseUomId ?? null}
            uomOptions={units?.options}
          />
        );
        }

      case "unit_price":
        if (isLocked("unit_price")) {
          return (
            <div className="pt-2 text-right tabular-nums">
              {formatCurrency(item.unit_price)}
            </div>
          );
        }
        return (
          <NumericInput
            value={item.unit_price}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { unit_price: v ?? 0 } as Partial<T>)}
            className="h-8"
          />
        );

      case "tax_rate":
        if (isLocked("tax_rate")) {
          return (
            <div className="pt-2 text-right tabular-nums">{item.tax_rate ?? 0}%</div>
          );
        }
        return (
          <NumericInput
            value={item.tax_rate ?? 0}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { tax_rate: v ?? 0 } as Partial<T>)}
            className="h-8"
          />
        );

      case "line_total":
        return (
          <div className="pt-2 text-right font-medium tabular-nums">
            {formatCurrency(
              item.line_total ??
                item.quantity * item.unit_price * (1 + (item.tax_rate ?? 0) / 100),
            )}
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
        stockEval || extra ? (
          <>
            {stockEval && (
              <StockLineStatus
                trackInventory={stockEval.product.track_inventory ?? undefined}
                productType={stockEval.product.type ?? undefined}
                onHand={
                  stockEval.product.available ??
                  stockEval.product.stock_quantity ??
                  undefined
                }
                reorderLevel={stockEval.product.reorder_level ?? undefined}
                requestedQty={item.quantity}
              />
            )}
            {extra}
          </>
        ) : undefined
      }
    />
  );
}

export const PricedLineRow = memo(PricedLineRowInner) as typeof PricedLineRowInner;
