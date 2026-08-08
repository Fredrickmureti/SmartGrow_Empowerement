/**
 * DeliveryNoteLineRow — the ONE line editor for delivery notes.
 *
 * A delivery line is a priced line plus a fulfilment pair (ordered vs
 * delivered) and a discount, so it cannot reuse `PricedLineRow`'s contract
 * verbatim. It renders into the same measured layout engine
 * (`EditableLineItemsGrid`), so the demotion behaviour, headers and compact
 * labels match every other document in the workspace.
 *
 * Props MUST be stable from the parent (`useCallback`) for the memo to hold.
 */

import { memo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { ProductCombobox, type ProductOption } from "@/components/common/ProductCombobox";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

/** Minimum line shape a delivery note line satisfies. */
export interface DeliveryLineShape {
  product_id?: string | null;
  description: string;
  quantity_ordered: number;
  quantity_delivered: number;
  unit_price: number;
  discount_percent?: number;
  tax_rate?: number;
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

export const DELIVERY_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "item", header: "Item", priority: 1, minWidth: 240 },
  {
    id: "quantity_ordered",
    header: "Ordered",
    priority: 3,
    minWidth: 100,
    numeric: true,
    compactLabel: "Qty ordered",
  },
  {
    id: "quantity_delivered",
    header: "Delivered",
    priority: 1,
    minWidth: 120,
    compactLabel: "Qty delivered",
  },
  {
    id: "unit_price",
    header: "Price",
    priority: 2,
    minWidth: 110,
    numeric: true,
    compactLabel: "Price",
  },
  {
    id: "discount_percent",
    header: "Disc %",
    priority: 3,
    minWidth: 90,
    numeric: true,
    compactLabel: "Disc %",
  },
  {
    id: "tax_rate",
    header: "Tax %",
    priority: 3,
    minWidth: 90,
    numeric: true,
    compactLabel: "Tax %",
  },
  { id: "line_total", header: "Total", priority: 2, minWidth: 110, numeric: true },
];

interface Props<T extends DeliveryLineShape> {
  index: number;
  item: T;
  products: ProductOption[];
  layout: EditableRowLayout;
  disabled?: boolean;
  /** Pre-computed, tax/discount-inclusive line total. */
  lineTotal: number;
  formatCurrency: (n: number) => string;
  onPatch: (index: number, patch: Partial<T>) => void;
  /** Quantity edits go through here so ordered/delivered can stay in step. */
  onDeliveredChange: (
    index: number,
    patch: {
      quantity?: number;
      packaging_id?: string | null;
      display_quantity?: number | null;
      display_uom_id?: string | null;
    },
  ) => void;
  extra?: ReactNode;
  /** Scanner flash — highlights the line a scan just landed on. */
  flashed?: boolean;
}

function DeliveryNoteLineRowInner<T extends DeliveryLineShape>({
  index,
  item,
  products,
  layout,
  disabled,
  lineTotal,
  formatCurrency,
  onPatch,
  onDeliveredChange,
  extra,
  flashed,
}: Props<T>) {
  const cell = (columnId: string) => {
    switch (columnId) {
      case "item":
        return (
          <div className="min-w-0 space-y-2">
            <ProductCombobox
              products={products}
              value={item.product_id || ""}
              onChange={(value) => onPatch(index, { product_id: value } as Partial<T>)}
              disabled={disabled}
              placeholder="Select product"
              className="w-full min-w-0"
            />
            <Input
              placeholder="Description"
              value={item.description}
              onChange={(e) => onPatch(index, { description: e.target.value } as Partial<T>)}
              className="h-8"
              disabled={disabled}
            />
          </div>
        );

      case "quantity_ordered":
        return (
          <NumericInput
            value={item.quantity_ordered}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { quantity_ordered: v ?? 0 } as Partial<T>)}
            className="h-8"
          />
        );

      case "quantity_delivered":
        return (
          <PackagedQtyCell
            productId={item.product_id ?? null}
            value={{
              quantity: item.quantity_delivered,
              packaging_id: item.packaging_id ?? null,
              display_quantity: item.display_quantity ?? null,
              display_uom_id: item.display_uom_id ?? null,
            }}
            onChange={(patch) => onDeliveredChange(index, patch)}
            disabled={disabled}
          />
        );

      case "unit_price":
        return (
          <NumericInput
            value={item.unit_price}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { unit_price: v ?? 0 } as Partial<T>)}
            className="h-8"
          />
        );

      case "discount_percent":
        return (
          <NumericInput
            value={item.discount_percent ?? 0}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { discount_percent: v ?? 0 } as Partial<T>)}
            className="h-8"
          />
        );

      case "tax_rate":
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
            {formatCurrency(lineTotal)}
          </div>
        );

      default:
        return null;
    }
  };

  return <EditableLineRowCells layout={layout} cell={cell} extra={extra} flashed={flashed} />;
}

export const DeliveryNoteLineRow = memo(
  DeliveryNoteLineRowInner,
) as typeof DeliveryNoteLineRowInner;
