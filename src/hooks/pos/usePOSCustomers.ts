import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { applyPartyScope } from "@/lib/contactAddresses";

export interface POSCustomer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  loyalty_points: number;
  loyalty_tier: "bronze" | "silver" | "gold" | "platinum";
  total_spent: number;
  visit_count: number;
  last_visit?: string;
}

export function usePOSCustomers() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  // Get customers with POS-relevant data
  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["pos-customers", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];

      let query = applyPartyScope(
        supabase.from("contacts").select("*"),
      )
        .eq("organization_id", currentOrg.id)
        .or("customer_rank.gt.0,type.eq.customer,type.eq.both")
        .eq("is_active", true)
        .order("name");

      // Filter by business if one is selected
      query = query.eq("business_id", currentBusiness!.id);
      const { data, error } = await query;

      if (error) throw error;

      // Map to POS customer format
      return data.map((contact) => ({
        id: contact.id,
        name: contact.name,
        email: contact.email || undefined,
        phone: contact.phone || undefined,
        loyalty_points: 0, // Would come from loyalty system
        loyalty_tier: "bronze" as const,
        total_spent: 0, // Would be calculated from transactions
        visit_count: 0,
        last_visit: undefined,
      })) as POSCustomer[];
    },
    enabled: !!currentOrg?.id,
  });

  // Search customers
  const searchCustomers = async (query: string): Promise<POSCustomer[]> => {
    if (!currentOrg?.id || !query) return [];

    let searchQuery = applyPartyScope(
      supabase.from("contacts").select("*"),
    )
      .eq("organization_id", currentOrg.id)
      .or("customer_rank.gt.0,type.eq.customer,type.eq.both")
      .eq("is_active", true)
      .or(`name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
      .limit(10);

    // Filter by business if one is selected
    searchQuery = searchQuery.eq("business_id", currentBusiness!.id);
    const { data, error } = await searchQuery;

    if (error) throw error;

    return data.map((contact) => ({
      id: contact.id,
      name: contact.name,
      email: contact.email || undefined,
      phone: contact.phone || undefined,
      loyalty_points: 0,
      loyalty_tier: "bronze" as const,
      total_spent: 0,
      visit_count: 0,
    }));
  };

  // Quick create customer with auto-enrollment in loyalty
  const createCustomer = useMutation({
    mutationFn: async (data: { name: string; email?: string; phone?: string }) => {
      if (!currentOrg?.id) throw new Error("No organization");

      const { data: result, error } = await supabase
        .from("contacts")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || null,
          name: data.name,
          email: data.email || null,
          phone: data.phone || null,
          type: "customer",
          // Phase 7: write the rank alongside the legacy enum so the new
          // row is visible to rank-based filters (`useContactsPaginated`,
          // `AdvancePaymentDialog`, etc.) immediately on insert.
          customer_rank: 1,
          supplier_rank: 0,
        })
        .select()
        .single();

      if (error) throw error;

      // Auto-enroll in loyalty program if one exists
      try {
        const { data: loyaltyProgram } = await supabase
          .from("loyalty_programs")
          .select("id")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("is_active", true)
          .single();

        if (loyaltyProgram && currentBusiness) {
          await supabase.from("customer_loyalty").insert({
            contact_id: result.id,
            program_id: loyaltyProgram.id,
            organization_id: currentOrg.id,
            business_id: currentBusiness.id,
            points_balance: 0,
            current_tier: "bronze",
          });
        }
      } catch {
        // No loyalty program or enrollment failed - continue silently
      }

      return {
        id: result.id,
        name: result.name,
        email: result.email || undefined,
        phone: result.phone || undefined,
        loyalty_points: 0,
        loyalty_tier: "bronze" as const,
        total_spent: 0,
        visit_count: 0,
      } as POSCustomer;
    },
    onSuccess: (customer) => {
      queryClient.invalidateQueries({ queryKey: ["pos-customers"] });
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      toast.success(`${customer.name} added and enrolled in loyalty program`);
    },
    onError: (error: Error) => {
      toast.error(`Failed to create customer: ${normalizeError(error).message}`);
    },
  });

  // Calculate loyalty points for a transaction
  const calculateLoyaltyPoints = (total: number): number => {
    // 1 point per dollar spent
    return Math.floor(total);
  };

  // Get tier based on total points
  const getLoyaltyTier = (
    totalPoints: number
  ): "bronze" | "silver" | "gold" | "platinum" => {
    if (totalPoints >= 10000) return "platinum";
    if (totalPoints >= 5000) return "gold";
    if (totalPoints >= 1000) return "silver";
    return "bronze";
  };

  // Get discount percentage based on tier
  const getTierDiscount = (tier: POSCustomer["loyalty_tier"]): number => {
    switch (tier) {
      case "platinum":
        return 10;
      case "gold":
        return 7;
      case "silver":
        return 5;
      case "bronze":
        return 0;
    }
  };

  return {
    customers,
    isLoading,
    searchCustomers,
    createCustomer,
    calculateLoyaltyPoints,
    getLoyaltyTier,
    getTierDiscount,
  };
}
