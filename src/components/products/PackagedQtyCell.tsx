/**
 * PackagedQtyCell — a reusable quantity + pack picker pair used by document
 * line editors (Invoice, Sales Order, PO, Bill, Estimate, Proforma, Delivery
 * Note, Goods Receipt, Returns).
 *
 * Keeps `quantity` in base units (what the ledger stores) while letting the
 * operator type the pack count and pick the pack. Mirrors the math the DB
 * BEFORE-trigger `_uom_normalize_line` runs server-side so live line totals
 * stay correct as the user types.
 *
 * Line shape required:
 *   - quantity (base units)
 *   - packaging_id?: string | null
 *   - display_quantity?: number | null
 *   - display_uom_id?: string | null   (kept null; server defaults to base UoM)
 */
import { NumericInput } from "@/components/ui/numeric-input";
import { PackagingSelect } from "@/components/products/PackagingSelect";

export interface PackagedQtyValue {
  quantity: number;
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

interface Props {
  productId: string | null | undefined;
  value: PackagedQtyValue;
  onChange: (patch: Partial<PackagedQtyValue>) => void;
  disabled?: boolean;
  /** Hide pack picker if the product has no packs defined. */
  hideEmptyPackSelect?: boolean;
  className?: string;
}

export function PackagedQtyCell({
  productId,
  value,
  onChange,
  disabled,
  hideEmptyPackSelect = true,
  className,
}: Props) {
  const displayQty = value.display_quantity ?? value.quantity;
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <NumericInput
        value={displayQty}
        disabled={disabled}
        onValueChange={(v) => {
          const qty = v ?? 0;
          const hasPack = !!value.packaging_id;
          const multiplier =
            hasPack && value.display_quantity != null && value.display_quantity > 0
              ? value.quantity / value.display_quantity
              : 1;
          onChange({
            display_quantity: hasPack ? qty : null,
            quantity: hasPack ? qty * multiplier : qty,
          });
        }}
        className="h-8"
      />
      <PackagingSelect
        productId={productId ?? null}
        value={value.packaging_id ?? null}
        disabled={disabled}
        hideWhenEmpty={hideEmptyPackSelect}
        onChange={(pkgId, packQty) => {
          if (!pkgId) {
            onChange({
              packaging_id: null,
              display_uom_id: null,
              display_quantity: null,
            });
            return;
          }
          const dq = value.display_quantity ?? 1;
          onChange({
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
}
