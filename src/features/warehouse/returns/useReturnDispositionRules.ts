/**
 * Disposition rules — declarative routing of returned stock.
 *
 * Rules are matched server-side by `wms_disposition_return_line`; this hook
 * only reads and maintains them so operators can see *why* a line routed the
 * way it did.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ReturnDispositionRule } from "./returnsModel";

export const RETURN_RULES_KEY = "wms-return-disposition-rules";

const RULE_COLUMNS =
  "id, business_id, warehouse_id, name, return_kind, condition_code, product_id, category_id, customer_id, disposition, destination_location_id, requires_inspection, priority, is_active";

export function useReturnDispositionRules(businessId: string | undefined) {
  return useQuery({
    queryKey: [RETURN_RULES_KEY, businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_disposition_rules" as any)
        .select(RULE_COLUMNS)
        .eq("business_id", businessId!)
        .order("priority", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ReturnDispositionRule[];
    },
  });
}

export function useSaveReturnDispositionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<ReturnDispositionRule> & { business_id: string }) => {
      const payload = {
        business_id: input.business_id,
        warehouse_id: input.warehouse_id ?? null,
        name: input.name ?? "Untitled rule",
        return_kind: input.return_kind ?? null,
        condition_code: input.condition_code ?? null,
        product_id: input.product_id ?? null,
        category_id: input.category_id ?? null,
        customer_id: input.customer_id ?? null,
        disposition: input.disposition ?? "restock",
        destination_location_id: input.destination_location_id ?? null,
        requires_inspection: input.requires_inspection ?? true,
        priority: input.priority ?? 100,
        is_active: input.is_active ?? true,
      };
      if (input.id) {
        const { error } = await supabase
          .from("wms_return_disposition_rules" as any)
          .update(payload)
          .eq("id", input.id);
        if (error) throw error;
        return { id: input.id };
      }
      const { data, error } = await supabase
        .from("wms_return_disposition_rules" as any)
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [RETURN_RULES_KEY] }),
  });
}

export function useDeleteReturnDispositionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("wms_return_disposition_rules" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [RETURN_RULES_KEY] }),
  });
}
