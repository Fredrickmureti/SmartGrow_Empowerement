/**
 * ContractLineRow — line editor for purchase contracts / blanket agreements.
 *
 * A contract line pre-agrees commercial terms rather than ordering goods: a
 * description, an agreed unit price and ceilings (quantity and/or value) that
 * are enforced when a PO draws down against the contract. There is no tax,
 * no ordered quantity and no line total, so it gets its own row on top of the
 * shared measured `EditableLineItemsGrid`.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers) or the
 * memo will not engage.
 */

import { memo } from "react";
import { Input } from "@/components/ui/input";
import { ProductCombobox, type ProductOption } from "@/components/common/ProductCombobox";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

export interface ContractLineShape {
  product_id?: string | null;
  supplier_sku?: string | null;
  description?: string | null;
  unit_price?: number | null;
  ceiling_quantity?: number | null;
  ceiling_value?: number | null;
}

export const CONTRACT_LINE_COLUMNS: EditableLineColumn[] = [
  {
    id: "product_id",
    header: "Product / service",
    priority: 1,
    minWidth: 200,
    compactLabel: "Item",
  },
  { id: "description", header: "Description", priority: 1, minWidth: 220 },
  {
    id: "unit_price",
    header: "Unit price",
    priority: 1,
    minWidth: 120,
    numeric: true,
    compactLabel: "Unit price",
  },
  {
    id: "ceiling_quantity",
    header: "Ceiling qty",
    priority: 2,
    minWidth: 120,
    numeric: true,
    compactLabel: "Ceiling qty",
  },
  {
    id: "ceiling_value",
    header: "Ceiling value",
    priority: 2,
    minWidth: 130,
    numeric: true,
    compactLabel: "Ceiling value",
  },
  {
    id: "supplier_sku",
    header: "Supplier SKU",
    priority: 3,
    minWidth: 140,
    compactLabel: "Supplier SKU",
  },
];

interface Props<T extends ContractLineShape> {
  index: number;
  item: T;
  /** Catalog products offered in the picker; empty list keeps lines free-text. */
  products?: ProductOption[];
  layout: EditableRowLayout;
  disabled?: boolean;
  onPatch: (index: number, patch: Partial<T>) => void;
}

function ContractLineRowInner<T extends ContractLineShape>({
  index,
  item,
  products = [],
  layout,
  disabled,
  onPatch,
}: Props<T>) {
  const numeric = (key: "unit_price" | "ceiling_quantity" | "ceiling_value") => (
    <NumericInput
      value={item[key] ?? null}
      disabled={disabled}
      onValueChange={(v) => onPatch(index, { [key]: v ?? null } as Partial<T>)}
      className="h-8"
    />
  );

  const cell = (columnId: string) => {
    switch (columnId) {
      case "product_id":
        return (
          <ProductCombobox
            products={products}
            value={item.product_id ?? null}
            disabled={disabled}
            placeholder="Free text"
            className="h-8"
            onChange={(productId) => {
              const p = products.find((x) => x.id === productId);
              onPatch(index, {
                product_id: productId,
                description: item.description?.trim()
                  ? item.description
                  : (p?.name ?? ""),
                unit_price:
                  Number(item.unit_price) > 0
                    ? item.unit_price
                    : (p?.unit_price ?? null),
              } as Partial<T>);
            }}
          />
        );

      case "supplier_sku":
        return (
          <Input
            value={item.supplier_sku ?? ""}
            placeholder="Supplier part no."
            disabled={disabled}
            onChange={(e) =>
              onPatch(index, { supplier_sku: e.target.value || null } as Partial<T>)
            }
            className="h-8"
          />
        );

      case "description":
        return (
          <Input
            value={item.description ?? ""}
            placeholder="Description"
            disabled={disabled}
            onChange={(e) => onPatch(index, { description: e.target.value } as Partial<T>)}
            className="h-8"
          />
        );
      case "unit_price":
        return numeric("unit_price");
      case "ceiling_quantity":
        return numeric("ceiling_quantity");
      case "ceiling_value":
        return numeric("ceiling_value");
      default:
        return null;
    }
  };

  return <EditableLineRowCells layout={layout} cell={cell} />;
}

export const ContractLineRow = memo(ContractLineRowInner) as typeof ContractLineRowInner;
