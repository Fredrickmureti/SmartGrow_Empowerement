/**
 * Inventory unit (base UoM) + optional distinct sales/purchase units.
 * The lock reason comes from the server (`useProductUomLock`); the form only
 * renders it.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Section, FieldGrid } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { UomSelect } from "@/components/products/UomSelect";
import type { ProductFormPatch, ProductFormValues } from "../formState";

export interface InventoryUnitSectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  baseUomLocked: boolean;
  lockReason?: string | null;
}

export function InventoryUnitSection({
  values,
  onChange,
  baseUomLocked,
  lockReason,
}: InventoryUnitSectionProps) {
  const [showAdvancedUoM, setShowAdvancedUoM] = useState(false);

  return (
    <Section title="Inventory unit" description="The unit stock and cost are stored in.">
      <div className="space-y-3">
        <div className="space-y-2">
          <Label>Inventory unit *</Label>
          <UomSelect
            value={values.base_uom_id}
            disabled={baseUomLocked}
            onChange={(id) =>
              onChange({ base_uom_id: id, sales_uom_id: id, purchase_uom_id: id })
            }
            placeholder="Pick the unit you count this product in…"
          />
          {baseUomLocked ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs space-y-1">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                Inventory unit is locked
              </p>
              <p className="text-amber-800 dark:text-amber-300">
                {lockReason} Changing the inventory unit after the product has been
                transacted would silently rescale stock value and history. To buy or
                sell in a different unit (e.g. grams against a KG base), add a{" "}
                <strong>Packaging</strong> entry above with the right multiplier.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Stock and cost are stored in this unit. Add packs above to buy or sell in
              cartons, strips, etc.
            </p>
          )}
        </div>
        <Collapsible open={showAdvancedUoM} onOpenChange={setShowAdvancedUoM}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
            >
              <ChevronDown
                className={`mr-1 h-3.5 w-3.5 transition-transform ${
                  showAdvancedUoM ? "rotate-180" : ""
                }`}
              />
              Advanced: different sales / purchase unit
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <FieldGrid columns={2}>
              <div className="space-y-2">
                <Label>Sales unit</Label>
                <UomSelect
                  value={values.sales_uom_id}
                  onChange={(id) => onChange({ sales_uom_id: id })}
                  placeholder="Defaults to inventory unit"
                  allowClear
                />
              </div>
              <div className="space-y-2">
                <Label>Purchase unit</Label>
                <UomSelect
                  value={values.purchase_uom_id}
                  onChange={(id) => onChange({ purchase_uom_id: id })}
                  placeholder="Defaults to inventory unit"
                  allowClear
                />
              </div>
            </FieldGrid>
            <p className="text-xs text-muted-foreground pt-2">
              Most products sell and buy in the same unit. Only set these when
              sales/purchase use a different UoM category.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Section>
  );
}

export default InventoryUnitSection;
