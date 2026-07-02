import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import type { 
  OrganizationPaymentMethod, 
  PaymentMethodInput, 
  PaymentMethodDetails 
} from "@/types/paymentMethod";
import type { Json } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

export function usePaymentMethods() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const queryKey = ["payment-methods", organizationId, businessId];

  // Fetch all payment methods for the organization
  const {
    data: paymentMethods = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      const { data, error } = await supabase
        .from("organization_payment_methods")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("display_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (error) throw error;

      // Type cast the response
      return (data || []).map((item): OrganizationPaymentMethod => ({
        id: item.id,
        organization_id: item.organization_id,
        type: item.type as OrganizationPaymentMethod["type"],
        label: item.label,
        details: item.details as PaymentMethodDetails,
        is_default: item.is_default,
        is_active: item.is_active,
        display_order: item.display_order,
        qr_code_enabled: item.qr_code_enabled,
        bank_account_id: item.bank_account_id,
        created_at: item.created_at,
        updated_at: item.updated_at,
      }));
    },
    enabled: !!organizationId && !!businessId,
  });

  // Create a new payment method
  const createMutation = useMutation({
    mutationFn: async (input: PaymentMethodInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("Select a Company before adding a payment method");

      const { data, error } = await supabase
        .from("organization_payment_methods")
        .insert({
          organization_id: organizationId,
          business_id: currentBusiness.id,
          branch_id: input.branch_id ?? null,
          type: input.type,
          label: input.label,
          details: input.details as unknown as Json,
          is_default: input.is_default ?? false,
          is_active: input.is_active ?? true,
          display_order: input.display_order ?? paymentMethods.length,
          qr_code_enabled: input.qr_code_enabled ?? false,
          bank_account_id: input.bank_account_id ?? null,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({
        title: "Payment method added",
        description: "The payment method has been added successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error adding payment method",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Update an existing payment method
  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: PaymentMethodInput & { id: string }) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a Company before updating payment method");
      const { data, error } = await supabase
        .from("organization_payment_methods")
        .update({
          type: input.type,
          label: input.label,
          details: input.details as unknown as Json,
          is_default: input.is_default,
          is_active: input.is_active,
          display_order: input.display_order,
          qr_code_enabled: input.qr_code_enabled,
          bank_account_id: input.bank_account_id,
          branch_id: input.branch_id ?? null,
        })
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({
        title: "Payment method updated",
        description: "The payment method has been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error updating payment method",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Delete a payment method
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a Company before deleting payment method");
      const { error } = await supabase
        .from("organization_payment_methods")
        .delete()
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({
        title: "Payment method deleted",
        description: "The payment method has been deleted.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error deleting payment method",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Toggle default status
  const setDefaultMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a Company before changing default payment method");

      // First, unset all defaults
      await supabase
        .from("organization_payment_methods")
        .update({ is_default: false })
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);

      // Then set the new default
      const { data, error } = await supabase
        .from("organization_payment_methods")
        .update({ is_default: true })
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({
        title: "Default payment method updated",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error setting default",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Toggle active status
  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a Company before updating payment method");
      const { data, error } = await supabase
        .from("organization_payment_methods")
        .update({ is_active })
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey });
      toast({
        title: variables.is_active ? "Payment method enabled" : "Payment method disabled",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error updating status",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Reorder payment methods
  const reorderMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a Company before reordering payment methods");
      const updates = orderedIds.map((id, index) => ({
        id,
        display_order: index,
      }));

      for (const update of updates) {
        const { error } = await supabase
          .from("organization_payment_methods")
          .update({ display_order: update.display_order })
          .eq("id", update.id)
          .eq("organization_id", organizationId)
          .eq("business_id", businessId);

        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: Error) => {
      toast({
        title: "Error reordering",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Get active payment methods only
  const activePaymentMethods = paymentMethods.filter((m) => m.is_active);

  // Get default payment methods
  const defaultPaymentMethods = paymentMethods.filter((m) => m.is_default && m.is_active);

  return {
    paymentMethods,
    activePaymentMethods,
    defaultPaymentMethods,
    isLoading,
    error,
    refetch,
    createPaymentMethod: createMutation.mutate,
    updatePaymentMethod: updateMutation.mutate,
    deletePaymentMethod: deleteMutation.mutate,
    setDefaultPaymentMethod: setDefaultMutation.mutate,
    toggleActivePaymentMethod: toggleActiveMutation.mutate,
    reorderPaymentMethods: reorderMutation.mutate,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}

/**
 * Hook to fetch payment methods by their IDs
 * Used when loading template-selected payment methods
 */
export function usePaymentMethodsByIds(ids: string[]) {
  return useQuery({
    queryKey: ["payment-methods-by-ids", ids],
    queryFn: async () => {
      if (!ids.length) return [];

      const { data, error } = await supabase
        .from("organization_payment_methods")
        .select("*")
        .in("id", ids)
        .order("display_order", { ascending: true });

      if (error) throw error;

      return (data || []).map((item): OrganizationPaymentMethod => ({
        id: item.id,
        organization_id: item.organization_id,
        type: item.type as OrganizationPaymentMethod["type"],
        label: item.label,
        details: item.details as PaymentMethodDetails,
        is_default: item.is_default,
        is_active: item.is_active,
        display_order: item.display_order,
        qr_code_enabled: item.qr_code_enabled,
        bank_account_id: item.bank_account_id,
        created_at: item.created_at,
        updated_at: item.updated_at,
      }));
    },
    enabled: ids.length > 0,
  });
}
