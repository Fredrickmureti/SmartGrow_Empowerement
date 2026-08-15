/**
 * PackagedQtyCell — a reusable quantity + pack picker pair used by document
 * line editors (Invoice, Sales Order, PO, Bill, Estimate, Proforma, Delivery
 * Note, Goods Receipt, Returns).
 *
 * Keeps `quantity` in base units (what the ledger stores) while letting the
 * operator type the customer quantity and pick the unit it was sold in — a
 * pack (carton, case) or an alternate unit of measure (kg for a product
 * stocked in g). The DB BEFORE-trigger `_uom_normalize_line` recomputes
 * `quantity` server-side through `resolve_line_base_quantity`; the maths here
 * is a live preview only, never the authority.
 *
 * Line shape required:
 *   - quantity (base units)
 *   - packaging_id?: string | null
 *   - display_quantity?: number | null
 *   - display_uom_id?: string | null   (null ⇒ server defaults to base UoM)
 */
import { NumericInput } from "@/components/ui/numeric-input";
import { PackagingSelect } from "@/components/products/PackagingSelect";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SellUnitOption } from "@/hooks/useSellableUnits";

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
  /** Product's stocking unit. Required to offer alternate sell units. */
  baseUomId?: string | null;
  /**
   * Alternate units the product may be sold in (same UoM category as the
   * base unit). Rendered only when more than one option exists.
   */
  uomOptions?: SellUnitOption[];
}

export function PackagedQtyCell({
  productId,
  value,
  onChange,
  disabled,
  hideEmptyPackSelect = true,
  className,
  baseUomId,
  uomOptions,
}: Props) {
  const displayQty = value.display_quantity ?? value.quantity;
  const alternates = uomOptions ?? [];
  const showUomSelect = !!baseUomId && !value.packaging_id && alternates.length > 1;
  const selectedUomId = value.display_uom_id ?? baseUomId ?? null;
  const uomFactor =
    alternates.find((u) => u.id === selectedUomId)?.factor ?? 1;
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <NumericInput
        value={displayQty}
        disabled={disabled}
        onValueChange={(v) => {
          const qty = v ?? 0;
          const hasPack = !!value.packaging_id;
          const packMultiplier =
            hasPack && value.display_quantity != null && value.display_quantity > 0
              ? value.quantity / value.display_quantity
              : 1;
          const usesAltUom =
            !hasPack && !!value.display_uom_id && value.display_uom_id !== baseUomId;
          if (hasPack) {
            onChange({ display_quantity: qty, quantity: qty * packMultiplier });
            return;
          }
          onChange({
            display_quantity: usesAltUom ? qty : null,
            quantity: usesAltUom ? qty * uomFactor : qty,
          });
        }}
        className="h-8"
      />
      {showUomSelect && (
        <Select
          value={selectedUomId ?? undefined}
          disabled={disabled}
          onValueChange={(uomId) => {
            const opt = alternates.find((u) => u.id === uomId);
            const factor = opt?.factor ?? 1;
            const qty = displayQty;
            if (uomId === baseUomId) {
              onChange({
                display_uom_id: null,
                display_quantity: null,
                quantity: qty,
              });
              return;
            }
            onChange({
              packaging_id: null,
              display_uom_id: uomId,
              display_quantity: qty,
              quantity: qty * factor,
            });
          }}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Unit" />
          </SelectTrigger>
          <SelectContent>
            {alternates.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.code}
                {u.id === baseUomId ? " (stock unit)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
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
