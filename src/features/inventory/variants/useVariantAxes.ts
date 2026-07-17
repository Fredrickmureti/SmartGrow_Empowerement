/**
 * Variant-axis catalogue hook — per-business list of axes with their values.
 * Backed by `product_variant_axes` + `product_variant_axis_values`.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface VariantAxisValue {
  id: string;
  value: string;
  display_order: number;
}

export interface VariantAxis {
  id: string;
  business_id: string;
  name: string;
  display_order: number;
  values: VariantAxisValue[];
}

export function variantAxesQueryKey(businessId: string | null | undefined) {
  return ["variant-axes", businessId ?? "none"] as const;
}

export function useVariantAxes(businessId: string | null | undefined) {
  return useQuery({
    queryKey: variantAxesQueryKey(businessId),
    enabled: !!businessId,
    queryFn: async (): Promise<VariantAxis[]> => {
      const { data: axes, error } = await supabase
        .from("product_variant_axes")
        .select("id,business_id,name,display_order")
        .eq("business_id", businessId!)
        .order("display_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      if (!axes || axes.length === 0) return [];

      const { data: values, error: vErr } = await supabase
        .from("product_variant_axis_values")
        .select("id,axis_id,value,display_order")
        .in(
          "axis_id",
          axes.map((a) => a.id),
        )
        .order("display_order", { ascending: true })
        .order("value", { ascending: true });
      if (vErr) throw vErr;

      const byAxis = new Map<string, VariantAxisValue[]>();
      for (const v of values ?? []) {
        const list = byAxis.get(v.axis_id) ?? [];
        list.push({ id: v.id, value: v.value, display_order: v.display_order });
        byAxis.set(v.axis_id, list);
      }
      return axes.map((a) => ({
        ...a,
        values: byAxis.get(a.id) ?? [],
      }));
    },
  });
}

export function useCreateVariantAxis(businessId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      if (!businessId) throw new Error("No business selected");
      const { data, error } = await supabase
        .from("product_variant_axes")
        .insert({ business_id: businessId, name: name.trim() })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variantAxesQueryKey(businessId) });
    },
  });
}

export function useAddAxisValue(businessId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ axisId, value }: { axisId: string; value: string }) => {
      const { error } = await supabase
        .from("product_variant_axis_values")
        .insert({ axis_id: axisId, value: value.trim() });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variantAxesQueryKey(businessId) });
    },
  });
}

export function useDeleteAxisValue(businessId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (valueId: string) => {
      const { error } = await supabase
        .from("product_variant_axis_values")
        .delete()
        .eq("id", valueId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variantAxesQueryKey(businessId) });
    },
  });
}
