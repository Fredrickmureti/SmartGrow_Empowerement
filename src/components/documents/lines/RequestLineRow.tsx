/**
 * RequestLineRow — the ONE line editor for *demand-side* purchasing documents
 * that request quantities without committing to a price: RFQs, purchase
 * requisitions and contract schedules.
 *
 * These documents carry item / description / qty plus an optional indicative
 * price (target price on an RFQ, estimated cost on a requisition, contracted
 * rate on a contract line). They have no tax column and no computed line
 * total, so they cannot reuse `PricedLineRow` without dead columns.
 *
 * Renders into the measured layout of `EditableLineItemsGrid`, exactly like
 * `PricedLineRow`: columns the container cannot hold are demoted onto a
 * labelled secondary line instead of scrolling horizontally.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers) or the
 * memo will not engage.
 */

import { memo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { ProductCombobox, type ProductOption } from "@/components/common/ProductCombobox";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import type { SellUnitOption } from "@/hooks/useSellableUnits";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

/** Minimum line shape every request-style purchasing document satisfies. */
export interface RequestLineShape {
  product_id?: string | null;
  description: string;
  quantity: number;
  /** Indicative price — target / estimated / contracted, per document. */
  target_price?: number | null;
  // UoM provenance — `quantity` is ALWAYS base units.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

/** Column contract shared by every request-style line editor. */
export const REQUEST_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "item", header: "Item", priority: 1, minWidth: 240 },
  { id: "quantity", header: "Qty", priority: 1, minWidth: 110, compactLabel: "Qty" },
  {
    id: "target_price",
    header: "Target price",
    priority: 2,
    minWidth: 120,
    numeric: true,
    compactLabel: "Target",
  },
];

/** Same contract with the indicative price column relabelled. */
export const requestLineColumns = (priceHeader: string): EditableLineColumn[] =>
  REQUEST_LINE_COLUMNS.map((c) =>
    c.id === "target_price"
      ? { ...c, header: priceHeader, compactLabel: priceHeader }
      : c,
  );

interface Props<T extends RequestLineShape> {
  index: number;
  item: T;
  /** Omit together with `hideProductPicker` for documents with no catalogue. */
  products?: ProductOption[];
  /** Renders the item cell as a bare description input. */
  hideProductPicker?: boolean;
  /** Layout resolved by `EditableLineItemsGrid` for the measured container. */
  layout: EditableRowLayout;
  disabled?: boolean;
  flashed?: boolean;
  formatCurrency: (n: number) => string;
  /** Applies a partial update to the line. */
  onPatch: (index: number, patch: Partial<T>) => void;
  /** Product selection — defaults to a plain `product_id` patch. */
  onProductSelect?: (index: number, productId: string) => void;
  /** Rendered full width beneath the row. */
  extra?: ReactNode;
  productPlaceholder?: string;
  /**
   * Alternate units the product may be requested in. Packs are offered from
   * the product master regardless. MUST be `useCallback`-stable.
   */
  unitsFor?: (
    productId: string | null | undefined,
  ) => { baseUomId: string | null; options: SellUnitOption[] } | null;
}

function RequestLineRowInner<T extends RequestLineShape>({
  index,
  item,
  products,
  hideProductPicker,
  layout,
  disabled,
  flashed,
  formatCurrency,
  onPatch,
  onProductSelect,
  extra,
  productPlaceholder,
  unitsFor,
}: Props<T>) {
  const cell = (columnId: string) => {
    switch (columnId) {
      case "item":
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
        );

      case "target_price":
        return (
          <NumericInput
            value={item.target_price ?? null}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { target_price: v ?? null } as Partial<T>)}
            className="h-8"
          />
        );

      default:
        return null;
    }
  };

  return (
    <EditableLineRowCells layout={layout} flashed={flashed} cell={cell} extra={extra} />
  );
}

export const RequestLineRow = memo(RequestLineRowInner) as typeof RequestLineRowInner;
