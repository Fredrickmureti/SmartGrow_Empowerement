/**
 * Inventory tracking, reorder policy and (create mode) opening stock entry.
 *
 * Opening stock is only *collected* here — it posts through
 * `create_product_with_opening_stock_atomic`, which owns the journal entry and
 * any approval requirement. The preview total below is a display aid, not a
 * posting decision.
 */
import { Section, FieldGrid } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ProductStockPanel } from "@/components/products/ProductStockPanel";
import type { ProductFormPatch, ProductFormValues } from "../formState";

export interface OpeningStockWarehouse {
  id: string;
  name: string;
  code?: string | null;
}

export interface InventoryTrackingSectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  /** Existing product id, or null in create mode. */
  productId: string | null;
  warehouses: OpeningStockWarehouse[];
  openingByWarehouse: Record<string, number>;
  openingCostByWarehouse: Record<string, number>;
  onOpeningQuantityChange: (warehouseId: string, quantity: number) => void;
  onOpeningCostChange: (warehouseId: string, unitCost: number) => void;
}

export function InventoryTrackingSection({
  values,
  onChange,
  productId,
  warehouses,
  openingByWarehouse,
  openingCostByWarehouse,
  onOpeningQuantityChange,
  onOpeningCostChange,
}: InventoryTrackingSectionProps) {
  const openingTotal = warehouses.reduce((sum, wh) => {
    const qty = Number(openingByWarehouse[wh.id] ?? 0);
    if (!(qty > 0)) return sum;
    const unitCost =
      Number(openingCostByWarehouse[wh.id]) > 0
        ? Number(openingCostByWarehouse[wh.id])
        : Number(values.cost_price) || 0;
    return sum + qty * unitCost;
  }, 0);

  return (
    <Section title="Inventory tracking" description="Stock and reorder policy.">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="track_inventory" className="text-base font-medium">
              Track inventory
            </Label>
            <p className="text-sm text-muted-foreground">
              Enable stock tracking for this product.
            </p>
          </div>
          <Switch
            id="track_inventory"
            checked={values.track_inventory}
            onCheckedChange={(checked) => onChange({ track_inventory: checked })}
          />
        </div>

        {values.track_inventory && (
          <>
            {productId ? (
              <ProductStockPanel
                productId={productId}
                productName={values.name}
                costPrice={Number(values.cost_price) || 0}
                unitPrice={Number(values.unit_price) || 0}
              />
            ) : (
              <div className="rounded-md border bg-muted/20 p-4 space-y-2">
                <Label className="text-sm font-semibold">Stock</Label>
                <p className="text-xs text-muted-foreground">
                  Stock totals derive from movements (receipts, sales, transfers,
                  adjustments) so valuation and the GL stay in sync. Use the{" "}
                  <strong>Opening stock per warehouse</strong> block below to seed
                  initial quantities — they post as a stock adjustment with{" "}
                  <code className="mx-1 text-[10px]">reason: opening_balance</code>
                  after the product is saved.
                </p>
              </div>
            )}

            {!productId && warehouses.length > 0 && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    Opening stock per warehouse
                  </Label>
                  <span className="text-xs text-muted-foreground">Optional</span>
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex-1">Warehouse</span>
                    <span className="w-28 text-right">Quantity</span>
                    <span className="w-28 text-right">Unit cost</span>
                  </div>
                  {warehouses.map((wh) => {
                    const qty = openingByWarehouse[wh.id] ?? 0;
                    const showCostError =
                      Number(qty) > 0 &&
                      !(
                        Number(openingCostByWarehouse[wh.id]) > 0 ||
                        Number(values.cost_price) > 0
                      );
                    return (
                      <div key={wh.id} className="flex items-start gap-2">
                        <span className="flex-1 text-sm pt-2">
                          {wh.name}{" "}
                          <span className="text-muted-foreground">({wh.code})</span>
                        </span>
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          placeholder="0"
                          className="w-28"
                          value={openingByWarehouse[wh.id] ?? ""}
                          onChange={(e) =>
                            onOpeningQuantityChange(
                              wh.id,
                              parseFloat(e.target.value) || 0,
                            )
                          }
                        />
                        <div className="w-28">
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            placeholder={String(values.cost_price || 0)}
                            aria-invalid={showCostError}
                            className={showCostError ? "w-28 border-destructive" : "w-28"}
                            value={openingCostByWarehouse[wh.id] ?? ""}
                            onChange={(e) =>
                              onOpeningCostChange(wh.id, parseFloat(e.target.value) || 0)
                            }
                          />
                          {showCostError && (
                            <p className="text-[10px] text-destructive mt-0.5">
                              Required &gt; 0
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {openingTotal > 0 && (
                  <div className="rounded-md bg-muted/50 border p-2 text-xs space-y-1">
                    <p className="font-medium">This will post a journal entry:</p>
                    <p className="font-mono">
                      Dr Inventory{" "}
                      {openingTotal.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      &nbsp;/&nbsp; Cr Opening Balance Equity{" "}
                      {openingTotal.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-muted-foreground">
                      Valued at cost. Creating the product with no opening quantity
                      posts nothing to the general ledger.
                    </p>
                  </div>
                )}
              </div>
            )}

            <FieldGrid columns={2}>
              <div className="space-y-2">
                <Label htmlFor="reorder_level">Reorder level</Label>
                <Input
                  id="reorder_level"
                  type="number"
                  min="0"
                  value={values.reorder_level}
                  onChange={(e) =>
                    onChange({ reorder_level: parseInt(e.target.value) || 0 })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Alert when stock falls below this level.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reorder_quantity">Reorder quantity</Label>
                <Input
                  id="reorder_quantity"
                  type="number"
                  min="0"
                  value={values.reorder_quantity}
                  onChange={(e) =>
                    onChange({ reorder_quantity: parseInt(e.target.value) || 0 })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Suggested quantity to reorder.
                </p>
              </div>
            </FieldGrid>
          </>
        )}
      </div>
    </Section>
  );
}

export default InventoryTrackingSection;
