/**
 * useScrap — single entry point into the scrap / waste lifecycle.
 *
 * Wraps the hardened `stock_adjustments` engine with react-query so
 * every UI surface (log, detail sheet, dashboards) invalidates the
 * same cache keys and consumes the same RPC contracts. Do not call
 * `record_scrap_atomic` or `reverse_stock_adjustment_atomic` directly
 * from components — always go through this hook.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

const SCRAP_KEYS = {
  reasons: (orgId?: string) => ["scrap-reasons", orgId] as const,
  list: () => ["scrap-adjustments"] as const,
  detail: (id?: string | null) => ["scrap-detail", id] as const,
};

export interface ScrapReason {
  id: string;
  organization_id: string;
  code: string;
  label: string;
  description: string | null;
  requires_attachment: boolean;
  requires_approval_above: number;
  insurance_claim_flag: boolean;
  quality_hold_flag: boolean;
  regulatory_reporting_flag: boolean;
  sort_order: number;
  is_active: boolean;
}

export function useScrapReasons() {
  const { currentOrg } = useOrganization();
  return useQuery({
    queryKey: SCRAP_KEYS.reasons(currentOrg?.id),
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<ScrapReason[]> => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase as any)
        .from("scrap_reasons")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ScrapReason[];
    },
  });
}

export interface RecordScrapInput {
  product_id: string;
  warehouse_id: string | null;
  quantity: number;
  unit_cost: number;
  reason: string;
  notes?: string | null;
}

export function useRecordScrap() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordScrapInput) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not signed in");
      const { data, error } = await supabase.rpc("record_scrap_atomic", {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness?.id || null,
        p_product_id: input.product_id,
        p_warehouse_id: input.warehouse_id,
        p_quantity: input.quantity,
        p_unit_cost: input.unit_cost,
        p_reason: input.reason,
        p_notes: input.notes ?? null,
        p_user_id: user.id,
      });
      if (error) throw error;
      const result = data as any;
      if (!result?.success) throw new Error(result?.error || "Failed to record scrap");
      return result as {
        success: true;
        adjustment_id: string;
        adjustment_number: string;
        gl_posted: boolean;
        journal_entry_id?: string;
      };
    },
    onSuccess: (result) => {
      const num = result.adjustment_number ? ` ${result.adjustment_number}` : "";
      toast.success(
        `Scrap${num} recorded${result.gl_posted ? " — journal entry posted" : ""}`,
      );
      qc.invalidateQueries({ queryKey: SCRAP_KEYS.list() });
      qc.invalidateQueries({ queryKey: ["stock-movements"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });
}

export function useReverseScrap() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: { scrapId: string; reason: string }) => {
      if (!user?.id) throw new Error("Not signed in");
      const { data, error } = await supabase.rpc("reverse_stock_adjustment_atomic", {
        p_adjustment_id: args.scrapId,
        p_user_id: user.id,
        p_reversal_reason: args.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, vars) => {
      toast.success("Scrap reversed", {
        description: "Inventory restored and mirror journal entry posted.",
      });
      qc.invalidateQueries({ queryKey: SCRAP_KEYS.list() });
      qc.invalidateQueries({ queryKey: SCRAP_KEYS.detail(vars.scrapId) });
      qc.invalidateQueries({ queryKey: ["stock-movements"] });
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });
}

export const scrapQueryKeys = SCRAP_KEYS;
