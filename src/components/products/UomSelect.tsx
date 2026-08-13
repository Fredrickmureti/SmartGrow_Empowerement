/**
 * UomSelect — dropdown that lists units of measure for the active business.
 *
 * Backed by `units_of_measure` (per-business). Phase B uses this for the
 * base / sales / purchase UoM pickers on the product form.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UomSelectProps {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /**
   * Restrict the list to units whose UoM category measures this physical
   * dimension (`uom_categories.dimension`). Used by the physical-attribute
   * editors so a weight can never be captured in litres. The database
   * enforces the same rule — this is convenience, not the invariant.
   */
  dimension?: "count" | "mass" | "volume" | "length" | "area";
}

export function UomSelect({
  value,
  onChange,
  placeholder = "Select unit…",
  disabled,
  allowClear = false,
  dimension,
}: UomSelectProps) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const { data: units = [], isLoading } = useQuery({
    queryKey: ["units-of-measure", businessId, dimension ?? "all"],
    enabled: !!businessId,
    queryFn: async () => {
      let query = supabase
        .from("units_of_measure")
        .select(
          "id, name, code, uom_type, factor_to_reference, uom_categories!inner(dimension)",
        )
        .eq("business_id", businessId!)
        .eq("is_active", true);
      if (dimension) query = query.eq("uom_categories.dimension", dimension);
      const { data, error } = await query
        .order("uom_type", { ascending: true })
        .order("factor_to_reference", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });


  return (
    <Select
      value={value ?? "__none__"}
      onValueChange={(v) => onChange(v === "__none__" ? null : v)}
      disabled={disabled || isLoading}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowClear && <SelectItem value="__none__">— None —</SelectItem>}
        {units.map((u: any) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name} {u.code ? `(${u.code})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
