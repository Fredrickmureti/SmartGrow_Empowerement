/**
 * Product-level purchasing defaults (ADR 0141).
 *
 * These two fields are the LAST-RESORT fallback only. Purchasing policy is
 * owned by the supplier↔product relationship (`supplier_item_terms`) and
 * resolved on the server by `resolve_supplier_purchasing_terms`; enforcement
 * arithmetic lives in `validate_supplier_order_quantity`. This section renders
 * and edits the master values — it never compares, rounds or validates a
 * quantity in the browser.
 */
import { Section, FieldGrid } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface PurchasingDefaultsSectionProps {
  minOrderQuantity: number;
  orderQuantityIncrement: number;
  onChange: (patch: {
    min_order_quantity?: number;
    order_quantity_increment?: number;
  }) => void;
  disabled?: boolean;
}

export function PurchasingDefaultsSection({
  minOrderQuantity,
  orderQuantityIncrement,
  onChange,
  disabled,
}: PurchasingDefaultsSectionProps) {
  return (
    <Section
      title="Fallback purchasing defaults"
      description="Used only when the supplier has no purchasing terms for this item. Supplier terms always win."
    >
      <FieldGrid columns={2}>
        <div className="space-y-2">
          <Label htmlFor="min_order_quantity">Minimum order quantity</Label>
          <Input
            id="min_order_quantity"
            type="number"
            min="1"
            step="1"
            disabled={disabled}
            value={minOrderQuantity}
            onChange={(e) =>
              onChange({ min_order_quantity: parseInt(e.target.value) || 1 })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="order_quantity_increment">Order increment</Label>
          <Input
            id="order_quantity_increment"
            type="number"
            min="1"
            step="1"
            disabled={disabled}
            value={orderQuantityIncrement}
            onChange={(e) =>
              onChange({
                order_quantity_increment: parseInt(e.target.value) || 1,
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Order in multiples of this value (e.g. case of 12) when the supplier
            defines no increment of its own.
          </p>
        </div>
      </FieldGrid>
    </Section>
  );
}

export default PurchasingDefaultsSection;
