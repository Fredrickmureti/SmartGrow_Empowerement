/**
 * SalesReturnLineRow — the ONE line editor for sales returns / RMAs.
 *
 * A return line is a priced line plus a `condition` disposition and a
 * `max_quantity` ceiling inherited from the originating invoice, so it
 * carries its own column contract. It renders into the shared measured
 * layout engine (`EditableLineItemsGrid`) so demotion, headers and compact
 * labels match every other document in the workspace.
 *
 * Props MUST be stable from the parent (`useCallback`) for the memo to hold.
 */

import { memo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProductCombobox, type ProductOption } from "@/components/common/ProductCombobox";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

/** Minimum line shape a sales-return line satisfies. */
export interface ReturnLineShape {
  product_id?: string | null;
  /**
   * Set when the line came from an invoice line picked through the
   * reference-document picker. Its presence is what makes the line
   * carry cost/tax provenance — and what locks product and price.
   */
  invoice_item_id?: string | null;
  description: string;
  quantity: number;
  max_quantity: number;
  unit_price: number;
  tax_rate?: number;
  tax_amount?: number;
  condition?: string;
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

export const RETURN_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "item", header: "Item", priority: 1, minWidth: 240 },
  { id: "quantity", header: "Qty", priority: 1, minWidth: 120, compactLabel: "Qty" },
  {
    id: "unit_price",
    header: "Price",
    priority: 2,
    minWidth: 110,
    numeric: true,
    compactLabel: "Price",
  },
  { id: "condition", header: "Condition", priority: 2, minWidth: 130 },
  { id: "line_total", header: "Total", priority: 3, minWidth: 110, numeric: true },
];

const CONDITIONS = [
  { value: "good", label: "Good" },
  { value: "damaged", label: "Damaged" },
  { value: "defective", label: "Defective" },
];

interface Props<T extends ReturnLineShape> {
  index: number;
  item: T;
  products: ProductOption[];
  layout: EditableRowLayout;
  disabled?: boolean;
  /**
   * Document-level hint kept for callers that still pass it. Provenance is
   * decided PER LINE by `item.invoice_item_id` so invoice-sourced lines and
   * deliberate off-invoice lines can coexist in one grid.
   */
  fromInvoice?: boolean;
  /** Reference document number rendered on invoice-sourced lines. */
  sourceDocumentLabel?: string | null;
  formatCurrency: (n: number) => string;
  onPatch: (index: number, patch: Partial<T>) => void;
  extra?: ReactNode;
  /** Scanner flash — highlights the line a scan just landed on. */
  flashed?: boolean;
}

function SalesReturnLineRowInner<T extends ReturnLineShape>({
  index,
  item,
  products,
  layout,
  disabled,
  fromInvoice,
  sourceDocumentLabel,
  formatCurrency,
  onPatch,
  extra,
  flashed,
}: Props<T>) {
  // Per-line provenance: an invoice-sourced line is locked to what was
  // actually invoiced; anything else is a deliberate off-invoice line.
  const invoiceSourced = !!item.invoice_item_id;

  const cell = (columnId: string) => {
    switch (columnId) {
      case "item":
        return (
          <div className="min-w-0 space-y-2">
            {!invoiceSourced && (
              <ProductCombobox
                products={products}
                value={item.product_id || ""}
                onChange={(value) => onPatch(index, { product_id: value } as Partial<T>)}
                disabled={disabled}
                placeholder="Select product"
                className="w-full min-w-0"
              />
            )}
            <Input
              value={item.description}
              onChange={(e) => onPatch(index, { description: e.target.value } as Partial<T>)}
              placeholder="Item description"
              readOnly={invoiceSourced}
              className="h-8"
              disabled={disabled}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {invoiceSourced ? (
                <Badge variant="outline" className="text-[10px] font-normal">
                  from {sourceDocumentLabel || "invoice"}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] font-normal">
                  Off-invoice · no tax/cost basis
                </Badge>
              )}
            </div>
          </div>
        );


      case "quantity":
        return (
          <div className="space-y-1">
            <PackagedQtyCell
              productId={item.product_id ?? null}
              value={{
                quantity: item.quantity,
                packaging_id: item.packaging_id ?? null,
                display_quantity: item.display_quantity ?? null,
                display_uom_id: item.display_uom_id ?? null,
              }}
              onChange={(patch) => onPatch(index, patch as Partial<T>)}
              disabled={disabled}
            />
            {item.max_quantity < 999 && (
              <p className="text-[10px] text-muted-foreground">
                {invoiceSourced ? "returnable" : "max"} {item.max_quantity}
              </p>
            )}
          </div>
        );

      case "unit_price":
        // Invoice-sourced lines credit exactly what was charged (net of the
        // original discount). Editing that here would silently break the
        // credit note and the tax basis the server resolves.
        return invoiceSourced ? (
          <div className="pt-2 text-right font-medium tabular-nums">
            {formatCurrency(item.unit_price)}
          </div>
        ) : (
          <NumericInput
            value={item.unit_price}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { unit_price: v ?? 0 } as Partial<T>)}
            className="h-8"
          />
        );


      case "condition":
        return (
          <Select
            value={item.condition ?? "good"}
            disabled={disabled}
            onValueChange={(v) => onPatch(index, { condition: v } as Partial<T>)}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case "line_total":
        return (
          <div className="pt-2 text-right font-medium tabular-nums">
            {formatCurrency(item.quantity * item.unit_price + (item.tax_amount ?? 0))}
          </div>
        );

      default:
        return null;
    }
  };

  return <EditableLineRowCells layout={layout} cell={cell} extra={extra} flashed={flashed} />;
}

export const SalesReturnLineRow = memo(
  SalesReturnLineRowInner,
) as typeof SalesReturnLineRowInner;
