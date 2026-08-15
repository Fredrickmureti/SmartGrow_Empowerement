/**
 * POSUnitSelectDialog — lets a cashier pick which packaging level (Each /
 * Strip / Box …) to sell when they tap a product tile, instead of relying
 * solely on a scannable pack barcode.
 *
 * Mirrors the barcode path's ledger invariant: the value passed back to the
 * cart is the BASE-unit quantity (chosen qty × pack `qty_in_base_uom`) plus
 * the packaging provenance (`packaging_id`, `display_quantity`) and the unit
 * price for that pack. Per-pack pricing comes from `product_pricing`
 * (packaging-specific active rows); when none exists the price falls back to
 * basePrice × qty_in_base_uom so valuation stays consistent.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { derivePackPrice } from "@/lib/inventory/price";

export interface PackOption {
  /** null = base unit ("Each") */
  packagingId: string | null;
  name: string;
  qtyInBaseUom: number;
  unitPrice: number;
}

export interface UnitSelection {
  packagingId: string | null;
  baseUomId: string | null;
  /** Number of packs/units the cashier entered (display quantity). */
  displayQuantity: number;
  /** Base-unit quantity that hits the ledger. */
  baseQuantity: number;
  /** Price per selected pack/unit. */
  unitPrice: number;
  packagingLabel: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string | null;
  productName: string;
  baseUomId: string | null;
  /** Effective per-base-unit selling price (already happy-hour adjusted). */
  basePrice: number;
  formatCurrency: (n: number) => string;
  onConfirm: (selection: UnitSelection) => void;
}

export function POSUnitSelectDialog({
  open,
  onOpenChange,
  productId,
  productName,
  baseUomId,
  basePrice,
  formatCurrency,
  onConfirm,
}: Props) {
  const [selectedKey, setSelectedKey] = useState<string>("__base__");
  const [qty, setQty] = useState<string>("1");

  /**
   * A product stocked in kilograms or litres MUST be sellable as 0.75 of a
   * base unit. Only a `count`-dimension base unit is genuinely indivisible,
   * so the integer clamp is driven by the UoM category, never assumed.
   */
  const { data: baseUom } = useQuery({
    queryKey: ["pos-base-uom", baseUomId],
    enabled: open && !!baseUomId,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units_of_measure")
        .select("id, code, name, category:uom_categories!category_id(dimension)")
        .eq("id", baseUomId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const baseLabel =
    (baseUom?.code || baseUom?.name || "").trim() || "base unit";
  const allowFractional =
    !!baseUom?.category?.dimension && baseUom.category.dimension !== "count";

  const { data: options = [], isLoading } = useQuery<PackOption[]>({
    queryKey: ["pos-unit-options", productId],
    enabled: open && !!productId,
    staleTime: 60_000,
    queryFn: async () => {

      const [{ data: packs, error: packErr }, { data: pricing, error: priceErr }] =
        await Promise.all([
          supabase
            .from("product_packaging")
            .select("id, name, qty_in_base_uom")
            .eq("product_id", productId!)
            .order("qty_in_base_uom", { ascending: true }),
          supabase
            .from("product_pricing")
            .select("packaging_id, price, min_quantity")
            .eq("product_id", productId!)
            .eq("is_active", true),
        ]);
      if (packErr) throw packErr;
      if (priceErr) throw priceErr;

      const priceByPack = new Map<string, number>();
      for (const row of pricing ?? []) {
        if (row.packaging_id && (row.min_quantity ?? 1) <= 1) {
          priceByPack.set(row.packaging_id, Number(row.price));
        }
      }

      const base: PackOption = {
        packagingId: null,
        name: "Each (base unit)",
        qtyInBaseUom: 1,
        unitPrice: basePrice,
      };
      const packOptions: PackOption[] = (packs ?? []).map((p) => {
        const factor = Number(p.qty_in_base_uom);
        return {
          packagingId: p.id,
          name: p.name,
          qtyInBaseUom: factor,
          unitPrice: priceByPack.get(p.id) ?? derivePackPrice(basePrice, factor),
        };
      });
      return [base, ...packOptions];
    },
  });

  // Default to the largest pack flagged elsewhere isn't tracked here, so keep
  // base unit selected; reset selection whenever the dialog reopens.
  useEffect(() => {
    if (open) {
      setSelectedKey("__base__");
      setQty("1");
    }
  }, [open, productId]);

  const selected = useMemo(
    () =>
      options.find((o) => (o.packagingId ?? "__base__") === selectedKey) ??
      options[0] ??
      null,
    [options, selectedKey],
  );

  const numericQty = Math.max(1, Math.floor(Number(qty) || 0));
  const baseQuantity = selected ? numericQty * selected.qtyInBaseUom : numericQty;
  const lineTotal = selected ? numericQty * selected.unitPrice : 0;

  const confirm = () => {
    if (!selected) return;
    onConfirm({
      packagingId: selected.packagingId,
      baseUomId,
      displayQuantity: numericQty,
      baseQuantity,
      unitPrice: selected.unitPrice,
      packagingLabel: selected.packagingId ? selected.name : "Each",
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select unit — {productName}</DialogTitle>
          <DialogDescription>
            Choose how you're selling this item. Stock is always deducted in
            base units.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2">
              {options.map((o) => {
                const key = o.packagingId ?? "__base__";
                const isSel = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-left transition-colors ${
                      isSel
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    <span className="text-sm font-medium">
                      {o.name}
                      {o.packagingId ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          (×{o.qtyInBaseUom})
                        </span>
                      ) : null}
                    </span>
                    <span className="text-sm tabular-nums">
                      {formatCurrency(o.unitPrice)}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pos-unit-qty">Quantity</Label>
              <Input
                id="pos-unit-qty"
                type="number"
                min={1}
                step={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
                autoFocus
              />
            </div>

            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {selected && selected.qtyInBaseUom > 1
                  ? `${baseQuantity} base units`
                  : `${baseQuantity} unit${baseQuantity === 1 ? "" : "s"}`}
              </span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(lineTotal)}
              </span>
            </div>

            <Button className="w-full" onClick={confirm} disabled={!selected}>
              Add to cart
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
