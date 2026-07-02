import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface ProductReorderRule {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  product_id: string;
  
  // Thresholds
  min_quantity: number;
  max_quantity: number | null;
  warning_threshold: number | null;
  critical_threshold: number | null;
  
  // Supplier & Lead Time
  lead_time_days: number;
  preferred_supplier_id: string | null;
  
  // Automation
  auto_create_po: boolean;
  reorder_quantity: number | null;
  
  // Notifications
  custom_notification_enabled: boolean;
  notify_user_ids: string[];
  
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function useProductReorderRules(productId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch rules for a product or all products
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["product-reorder-rules", organizationId, businessId, productId],
    queryFn: async () => {
      if (!organizationId) return [];

      let query = supabase
        .from("product_reorder_rules")
        .select(`
          *,
          product:products(id, name, sku),
          supplier:contacts(id, name)
        `)
        .eq("organization_id", organizationId)
        .eq("is_active", true);

      if (businessId) {
        query = query.or(`business_id.eq.${businessId},business_id.is.null`);
      }

      if (productId) {
        query = query.eq("product_id", productId);
      }

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;
      return data as (ProductReorderRule & { 
        product: { id: string; name: string; sku: string | null } | null;
        supplier: { id: string; name: string } | null;
      })[];
    },
    enabled: !!organizationId,
  });

  // Create rule mutation
  const createRuleMutation = useMutation({
    mutationFn: async (rule: Omit<ProductReorderRule, 'id' | 'created_at' | 'updated_at' | 'organization_id'>) => {
      if (!organizationId) throw new Error("Missing organization");

      const { data, error } = await supabase
        .from("product_reorder_rules")
        .insert({
          ...rule,
          organization_id: organizationId,
          business_id: businessId || null,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-reorder-rules"] });
      toast.success("Reorder rule created");
    },
    onError: (error: Error) => {
      toast.error(`Failed to create rule: ${normalizeError(error).message}`);
    },
  });

  // Update rule mutation
  const updateRuleMutation = useMutation({
    mutationFn: async ({ id, ...updates }: Partial<ProductReorderRule> & { id: string }) => {
      const { error } = await supabase
        .from("product_reorder_rules")
        .update(updates)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-reorder-rules"] });
      toast.success("Reorder rule updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update rule: ${normalizeError(error).message}`);
    },
  });

  // Delete rule mutation
  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("product_reorder_rules")
        .update({ is_active: false })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-reorder-rules"] });
      toast.success("Reorder rule deleted");
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete rule: ${normalizeError(error).message}`);
    },
  });

  // Get rule for a specific product
  const getRuleForProduct = (pid: string) => {
    return rules.find(r => r.product_id === pid);
  };

  return {
    rules,
    isLoading,
    createRule: createRuleMutation.mutate,
    updateRule: updateRuleMutation.mutate,
    deleteRule: deleteRuleMutation.mutate,
    getRuleForProduct,
    isCreating: createRuleMutation.isPending,
    isUpdating: updateRuleMutation.isPending,
  };
}
