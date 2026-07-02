import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface PaymentTerm {
  id: string;
  organization_id: string;
  business_id: string;
  name: string;
  days: number;
  description: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentTermInput {
  name: string;
  days: number;
  description?: string;
  is_default?: boolean;
}

export function usePaymentTerms() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;

  // Fetch payment terms
  const { data: paymentTerms = [], isLoading } = useQuery({
    queryKey: ["payment-terms", organizationId, currentBusiness?.id],
    queryFn: async () => {
      if (!organizationId) return [];
      let query = supabase
        .from("payment_terms")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("is_active", true);

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }

      const { data, error } = await query.order("days", { ascending: true });

      if (error) throw error;
      return data as PaymentTerm[];
    },
    enabled: !!organizationId,
  });

  // Create payment term
  const createPaymentTerm = useMutation({
    mutationFn: async (input: CreatePaymentTermInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("Select a Company before updating payment terms");
      if (!currentBusiness?.id) throw new Error("Select a Company before creating payment terms");

      // If setting as default, unset other defaults first
      if (input.is_default) {
        await supabase
          .from("payment_terms")
          .update({ is_default: false })
          .eq("business_id", currentBusiness.id);
      }

      const { data, error } = await supabase
        .from("payment_terms")
        .insert({
          organization_id: organizationId,
          business_id: currentBusiness.id,
          name: input.name,
          days: input.days,
          description: input.description,
          is_default: input.is_default || false,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-terms"] });
      toast.success("Payment term created");
    },
    onError: (error) => {
      toast.error("Failed to create payment term: " + normalizeError(error).message);
    },
  });

  // Update payment term
  const updatePaymentTerm = useMutation({
    mutationFn: async ({ id, ...input }: CreatePaymentTermInput & { id: string }) => {
      if (!organizationId) throw new Error("No organization selected");

      // If setting as default, unset other defaults first within the same company
      if (input.is_default && currentBusiness?.id) {
        await supabase
          .from("payment_terms")
          .update({ is_default: false })
          .eq("organization_id", organizationId)
          .eq("business_id", currentBusiness.id)
          .neq("id", id);
      }

      const { error } = await supabase
        .from("payment_terms")
        .update({
          name: input.name,
          days: input.days,
          description: input.description,
          is_default: input.is_default,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("business_id", currentBusiness.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-terms"] });
      toast.success("Payment term updated");
    },
    onError: (error) => {
      toast.error("Failed to update payment term: " + normalizeError(error).message);
    },
  });

  // Delete payment term (soft delete)
  const deletePaymentTerm = useMutation({
    mutationFn: async (id: string) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("Select a Company before deleting payment terms");
      const { error } = await supabase
        .from("payment_terms")
        .update({ is_active: false })
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("business_id", currentBusiness.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-terms"] });
      toast.success("Payment term deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete payment term: " + normalizeError(error).message);
    },
  });

  const defaultPaymentTerm = paymentTerms.find(pt => pt.is_default);

  return {
    paymentTerms,
    defaultPaymentTerm,
    isLoading,
    createPaymentTerm,
    updatePaymentTerm,
    deletePaymentTerm,
  };
}
