/**
 * Supplier coverage (ADR 0142, Phase 12).
 *
 * Read-only projection over `public.v_supplier_coverage`: which products have
 * an approved, in-window supplier condition, which are single-sourced, and
 * which are uncovered. No engine here — the view is the authority.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

export type CoverageStatus = string;

export interface SupplierCoverageRow {
  business_id: string;
  product_id: string;
  product_name: string;
  sku: string | null;
  product_type: string | null;
  active_conditions: number;
  supplier_count: number;
  min_unit_price: number | null;
  max_unit_price: number | null;
  next_expiry: string | null;
  coverage_status: CoverageStatus;
}

export function useSupplierCoverage(enabled = true) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const { data = [], isLoading } = useQuery({
    queryKey: ["supplier-coverage", businessId],
    enabled: enabled && !!businessId,
    queryFn: async (): Promise<SupplierCoverageRow[]> => {
      const { data, error } = await (supabase as any)
        .from("v_supplier_coverage")
        .select("*")
        .eq("business_id", businessId)
        .order("coverage_status", { ascending: true })
        .order("product_name", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as any[]).map((row) => ({
        business_id: row.business_id,
        product_id: row.product_id,
        product_name: row.product_name,
        sku: row.sku ?? null,
        product_type: row.product_type ?? null,
        active_conditions: Number(row.active_conditions ?? 0),
        supplier_count: Number(row.supplier_count ?? 0),
        min_unit_price: row.min_unit_price === null ? null : Number(row.min_unit_price),
        max_unit_price: row.max_unit_price === null ? null : Number(row.max_unit_price),
        next_expiry: row.next_expiry ?? null,
        coverage_status: row.coverage_status,
      }));
    },
  });

  return { coverage: data, isLoading };
}