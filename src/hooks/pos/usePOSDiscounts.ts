import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface POSDiscount {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  discount_type: "percentage" | "fixed";
  value: number;
  min_purchase_amount: number | null;
  requires_approval: boolean;
  approval_role: string | null;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  created_at: string;
}

export function usePOSDiscounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: discounts = [], isLoading } = useQuery({
    queryKey: ["pos-discounts", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const { data, error } = await supabase
        .from("pos_discounts")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("name");

      if (error) throw error;
      return data as POSDiscount[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const createDiscount = useMutation({
    mutationFn: async (data: Omit<POSDiscount, "id" | "organization_id" | "business_id" | "created_at">) => {
      if (!currentOrg?.id) throw new Error("No organization");
      if (!currentBusiness?.id) throw new Error("No company selected");

      const { data: result, error } = await supabase
        .from("pos_discounts")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          ...data,
        } as any)
        .select()
        .single();

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-discounts"] });
      toast.success("Discount created");
    },
    onError: (error: Error) => {
      toast.error(`Failed to create discount: ${normalizeError(error).message}`);
    },
  });

  const updateDiscount = useMutation({
    mutationFn: async ({
      id,
      ...data
    }: Partial<POSDiscount> & { id: string }) => {
      const { data: result, error } = await supabase
        .from("pos_discounts")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-discounts"] });
      toast.success("Discount updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update: ${normalizeError(error).message}`);
    },
  });

  const deleteDiscount = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("pos_discounts")
        .update({ is_active: false })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-discounts"] });
      toast.success("Discount deleted");
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete: ${normalizeError(error).message}`);
    },
  });

  // Get applicable discounts based on cart total
  const getApplicableDiscounts = (cartTotal: number) => {
    const now = new Date().toISOString();
    return discounts.filter((d) => {
      if (d.min_purchase_amount && cartTotal < d.min_purchase_amount) {
        return false;
      }
      if (d.valid_from && d.valid_from > now) {
        return false;
      }
      if (d.valid_to && d.valid_to < now) {
        return false;
      }
      return true;
    });
  };

  // Calculate discount amount
  const calculateDiscount = (
    discount: POSDiscount,
    subtotal: number
  ): number => {
    if (discount.discount_type === "percentage") {
      return (subtotal * discount.value) / 100;
    }
    return Math.min(discount.value, subtotal);
  };

  return {
    discounts,
    isLoading,
    createDiscount,
    updateDiscount,
    deleteDiscount,
    getApplicableDiscounts,
    calculateDiscount,
  };
}
