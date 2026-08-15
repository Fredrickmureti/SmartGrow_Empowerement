/**
 * RequisitionLineRow — line editor for purchase requisitions.
 *
 * Requisitions request *demand* rather than committing to a purchase. A line
 * may reference the product master (catalogue demand, carrying product_id and
 * therefore UOM / category downstream) or stay free-text (non-catalog demand,
 * flagged `is_non_catalog` in the database and requiring a buyer to assign a
 * product before it can become stock). It also carries a quantity, an
 * estimated unit price, an optional suggested supplier and a per-line need-by
 * date. That column set is unique to requisitions, so it gets its own row on
 * top of the shared measured `EditableLineItemsGrid` rather than bending
 * `PricedLineRow` / `RequestLineRow` out of shape.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers) or the
 * memo will not engage.
 */

import { memo } from "react";
import { Input } from "@/components/ui/input";
import { ProductCombobox, type ProductOption } from "@/components/common/ProductCombobox";
import { NumericInput } from "@/components/ui/numeric-input";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import type { SellUnitOption } from "@/hooks/useSellableUnits";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

export interface RequisitionLineShape {
  product_id?: string | null;
  description: string;
  quantity: number;
  estimated_unit_price: number;
  suggested_supplier_id?: string | null;
  need_by_date?: string | null;
  // UoM provenance — `quantity` is ALWAYS base units; the server normalizer
  // (`_uom_normalize_line`) recomputes it from the entered pack / unit.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

export interface RequisitionSupplierOption {
  id: string;
  label: string;
}

export const REQUISITION_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "product_id", header: "Product / service", priority: 1, minWidth: 200, compactLabel: "Item" },
  { id: "description", header: "Description", priority: 1, minWidth: 220 },
  { id: "quantity", header: "Qty", priority: 1, minWidth: 90, numeric: true, compactLabel: "Qty" },
  {
    id: "estimated_unit_price",
    header: "Est. unit price",
    priority: 2,
    minWidth: 130,
    numeric: true,
    compactLabel: "Est. price",
  },
  {
    id: "suggested_supplier_id",
    header: "Suggested supplier",
    priority: 3,
    minWidth: 180,
    compactLabel: "Supplier",
  },
  { id: "need_by_date", header: "Need by", priority: 3, minWidth: 150, compactLabel: "Need by" },
];

interface Props<T extends RequisitionLineShape> {
  index: number;
  item: T;
  products: ProductOption[];
  suppliers: RequisitionSupplierOption[];
  suppliersLoading?: boolean;
  layout: EditableRowLayout;
  disabled?: boolean;
  onPatch: (index: number, patch: Partial<T>) => void;
  /**
   * Units a product may be requested in (pack or alternate UoM). Omit for
   * forms that only ever request in the stocking unit. MUST be stable.
   */
  unitsFor?: (
    productId: string | null | undefined,
  ) => { baseUomId: string | null; options: SellUnitOption[] } | null;
}

function RequisitionLineRowInner<T extends RequisitionLineShape>({
  index,
  item,
  products,
  suppliers,
  suppliersLoading,
  layout,
  disabled,
  onPatch,
  unitsFor,
}: Props<T>) {
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
                description: item.description?.trim() ? item.description : (p?.name ?? ""),
                estimated_unit_price:
                  Number(item.estimated_unit_price) > 0
                    ? item.estimated_unit_price
                    : Number(p?.unit_price ?? 0),
              } as Partial<T>);
            }}
          />
        );

      case "description":
        return (
          <Input
            value={item.description}
            placeholder="Description"
            disabled={disabled}
            onChange={(e) => onPatch(index, { description: e.target.value } as Partial<T>)}
            className="h-8"
          />
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

      case "estimated_unit_price":
        return (
          <NumericInput
            value={item.estimated_unit_price}
            disabled={disabled}
            onValueChange={(v) =>
              onPatch(index, { estimated_unit_price: v ?? 0 } as Partial<T>)
            }
            className="h-8"
          />
        );

      case "suggested_supplier_id":
        return (
          <Select
            value={item.suggested_supplier_id ?? "none"}
            disabled={disabled}
            onValueChange={(v) =>
              onPatch(index, {
                suggested_supplier_id: v === "none" ? null : v,
              } as Partial<T>)
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder={suppliersLoading ? "Loading…" : "None"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case "need_by_date":
        return (
          <Input
            type="date"
            value={item.need_by_date ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onPatch(index, { need_by_date: e.target.value || null } as Partial<T>)
            }
            className="h-8"
          />
        );

      default:
        return null;
    }
  };

  return <EditableLineRowCells layout={layout} cell={cell} />;
}

export const RequisitionLineRow = memo(
  RequisitionLineRowInner,
) as typeof RequisitionLineRowInner;
