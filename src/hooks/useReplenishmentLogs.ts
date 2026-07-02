import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface ReplenishmentLog {
  id: string;
  organization_id: string;
  business_id: string | null;
  product_id: string;
  reorder_rule_id: string;
  purchase_order_id: string | null;
  triggered_at: string;
  trigger_type: string;
  current_stock: number;
  reorder_quantity: number;
  status: string;
  error_message: string | null;
  created_at: string;
}

export type ReplenishmentLogWithRelations = ReplenishmentLog & {
  product: { id: string; name: string; sku: string | null } | null;
  purchase_order: { id: string; po_number: string; status: string } | null;
};

export function useReplenishmentLogs() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: logs = [], isLoading, refetch } = useQuery({
    queryKey: ["replenishment-logs", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId) return [];

      let query = (supabase as any)
        .from("replenishment_logs")
        .select(`
          *,
          product:products!product_id(id, name, sku),
          purchase_order:purchase_orders!purchase_order_id(id, po_number, status)
        `)
        .eq("organization_id", organizationId);

      if (businessId) {
        query = query.or(`business_id.eq.${businessId},business_id.is.null`);
      }

      const { data, error } = await query.order("triggered_at", { ascending: false }).limit(100);

      if (error) throw error;
      return data as ReplenishmentLogWithRelations[];
    },
    enabled: !!organizationId,
  });

  // Manually trigger replenishment check
  const triggerReplenishment = async () => {
    const { data, error } = await supabase.functions.invoke("check-inventory-alerts");
    if (error) throw error;
    await refetch();
    return data;
  };

  return {
    logs,
    isLoading,
    triggerReplenishment,
    refetch,
  };
}
