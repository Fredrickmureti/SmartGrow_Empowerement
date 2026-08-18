/**
 * PackagingSelect — lists active `product_packaging` rows for a product.
 *
 * Used by invoice / GRN line editors so the operator can record which pack
 * the line was sold/received in (carton, case, strip). The DB BEFORE-trigger
 * (`_uom_normalize_line`) renormalizes `quantity` to base units before the
 * row hits the ledger; this selector is the operator-facing provenance.
 *
 * Schema reference (migration 20260527131853): product_packaging columns are
 *   id, name, qty_in_base_uom, barcode_id,
 *   is_purchase_default, is_sales_default
 * (`barcode_id` was dropped in Phase D — identifiers point at the level via
 * `product_identifiers.packaging_id`.) No `label`, `pack_quantity`, or
 * `uom_id` columns exist — those were the
 * source of the earlier broken implementation.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PackagingSelectProps {
  productId: string | null | undefined;
  value: string | null | undefined;
  /**
   * Called with the packaging row id (or null for base unit) and the
   * pack's `qty_in_base_uom` multiplier (or null when base). Callers
   * derive the display UoM from the product's `base_uom_id` separately.
   */
  onChange: (
    packagingId: string | null,
    qtyInBaseUom: number | null,
    packName?: string | null,
  ) => void;
  disabled?: boolean;
  className?: string;
  /** When true the dropdown is hidden if the product has no packs defined. */
  hideWhenEmpty?: boolean;
}

type PackRow = {
  id: string;
  name: string;
  qty_in_base_uom: number;
};

export function PackagingSelect({
  productId,
  value,
  onChange,
  disabled,
  className,
  hideWhenEmpty,
}: PackagingSelectProps) {
  const { data: packs = [] } = useQuery<PackRow[]>({
    queryKey: ["product-packaging", productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_packaging")
        .select("id, name, qty_in_base_uom")
        .eq("product_id", productId!)
        .order("qty_in_base_uom", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PackRow[];
    },
  });

  if (hideWhenEmpty && packs.length === 0) return null;

  return (
    <Select
      value={value ?? "__base__"}
      onValueChange={(v) => {
        if (v === "__base__") {
          onChange(null, null, null);
          return;
        }
        const p = packs.find((x) => x.id === v);
        onChange(v, p ? Number(p.qty_in_base_uom) : null, p?.name ?? null);
      }}
      disabled={disabled || !productId}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder="Each" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__base__">Each (base unit)</SelectItem>
        {packs.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name} (×{Number(p.qty_in_base_uom)})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
