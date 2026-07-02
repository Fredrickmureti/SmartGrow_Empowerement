import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface LoyaltyTier {
  name: string;
  min_points: number;
  discount_percent: number;
}

export interface LoyaltyProgram {
  id: string;
  organization_id: string;
  name: string;
  points_per_currency: number;
  points_to_currency_ratio: number;
  minimum_points_redemption: number;
  tiers: LoyaltyTier[];
  is_active: boolean;
}

export interface LoyaltyProgramInput {
  name: string;
  points_per_currency: number;
  points_to_currency_ratio: number;
  minimum_points_redemption: number;
  tiers?: LoyaltyTier[];
  is_active?: boolean;
}

interface CustomerLoyalty {
  id: string;
  contact_id: string;
  program_id: string;
  points_balance: number;
  points_earned_total: number;
  points_redeemed_total: number;
  current_tier: string;
  total_spent: number;
  visit_count: number;
  last_visit: string | null;
}

export function usePOSLoyalty() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  // Fetch all loyalty programs (not just active)
  const { data: allPrograms, isLoading: allProgramsLoading } = useQuery({
    queryKey: ["loyalty-programs", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const { data, error } = await supabase
        // SCOPE-EXEMPT: "loyalty_programs" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
        .from("loyalty_programs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      
      return (data || []).map(p => ({
        ...p,
        tiers: (p.tiers as unknown as LoyaltyTier[]) || []
      })) as LoyaltyProgram[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Fetch active loyalty program for POS use
  const { data: program, isLoading: programLoading } = useQuery({
    queryKey: ["loyalty-program", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return null;

      const { data, error } = await supabase
        .from("loyalty_programs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .maybeSingle();

      if (error) throw error;
      
      if (data) {
        return {
          ...data,
          tiers: (data.tiers as unknown as LoyaltyTier[]) || []
        } as LoyaltyProgram;
      }
      return null;
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Create loyalty program
  const createProgramMutation = useMutation({
    mutationFn: async (input: LoyaltyProgramInput) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No organization or business");

      // If setting this as active, deactivate others first
      if (input.is_active !== false) {
        await supabase
          .from("loyalty_programs")
          .update({ is_active: false })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id);
      }

      const { data, error } = await supabase
        .from("loyalty_programs")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          name: input.name,
          points_per_currency: input.points_per_currency,
          points_to_currency_ratio: input.points_to_currency_ratio,
          minimum_points_redemption: input.minimum_points_redemption,
          tiers: (input.tiers || []) as unknown as null,
          is_active: input.is_active !== false,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Loyalty program created");
      queryClient.invalidateQueries({ queryKey: ["loyalty-programs"] });
      queryClient.invalidateQueries({ queryKey: ["loyalty-program"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to create program: ${normalizeError(error).message}`);
    },
  });

  // Update loyalty program
  const updateProgramMutation = useMutation({
    mutationFn: async ({ id, ...input }: LoyaltyProgramInput & { id: string }) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No organization or business");

      // If setting this as active, deactivate others first
      if (input.is_active) {
        await supabase
          .from("loyalty_programs")
          .update({ is_active: false })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .neq("id", id);
      }

      const { data, error } = await supabase
        .from("loyalty_programs")
        .update({
          name: input.name,
          points_per_currency: input.points_per_currency,
          points_to_currency_ratio: input.points_to_currency_ratio,
          minimum_points_redemption: input.minimum_points_redemption,
          tiers: (input.tiers || []) as unknown as null,
          is_active: input.is_active,
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Loyalty program updated");
      queryClient.invalidateQueries({ queryKey: ["loyalty-programs"] });
      queryClient.invalidateQueries({ queryKey: ["loyalty-program"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update program: ${normalizeError(error).message}`);
    },
  });

  // Delete loyalty program
  const deleteProgramMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("loyalty_programs")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Loyalty program deleted");
      queryClient.invalidateQueries({ queryKey: ["loyalty-programs"] });
      queryClient.invalidateQueries({ queryKey: ["loyalty-program"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete program: ${normalizeError(error).message}`);
    },
  });

  // Toggle program active status
  const toggleProgramMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No organization or business");

      // If activating, deactivate others first
      if (is_active) {
        await supabase
          .from("loyalty_programs")
          .update({ is_active: false })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .neq("id", id);
      }

      const { error } = await supabase
        .from("loyalty_programs")
        .update({ is_active })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Program status updated");
      queryClient.invalidateQueries({ queryKey: ["loyalty-programs"] });
      queryClient.invalidateQueries({ queryKey: ["loyalty-program"] });
    },
  });

  // Fetch customer loyalty info
  const fetchCustomerLoyalty = async (contactId: string): Promise<CustomerLoyalty | null> => {
    if (!program) return null;

    const { data, error } = await supabase
      .from("customer_loyalty")
      .select("*")
      .eq("contact_id", contactId)
      .eq("program_id", program.id)
      .single();

    if (error && error.code !== "PGRST116") throw error;
    return data as CustomerLoyalty | null;
  };

  // Create or update loyalty for customer
  const ensureCustomerLoyalty = async (contactId: string): Promise<CustomerLoyalty> => {
    if (!program) throw new Error("No loyalty program configured");
    if (!currentOrg || !currentBusiness) throw new Error("No active business");

    const existing = await fetchCustomerLoyalty(contactId);
    if (existing) return existing;

    const { data, error } = await supabase
      .from("customer_loyalty")
      .insert({
        contact_id: contactId,
        program_id: program.id,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      })
      .select()
      .single();

    if (error) throw error;
    return data as CustomerLoyalty;
  };

  // Calculate points for a transaction amount
  const calculatePoints = (amount: number): number => {
    if (!program) return 0;
    return Math.floor(amount * program.points_per_currency);
  };

  // Calculate cash value of points
  const calculatePointsValue = (points: number): number => {
    if (!program) return 0;
    return points * program.points_to_currency_ratio;
  };

  // Get tier for given points
  const getTierForPoints = (totalPoints: number): LoyaltyTier => {
    if (!program || !program.tiers.length) {
      return { name: "Standard", min_points: 0, discount_percent: 0 };
    }

    const sortedTiers = [...program.tiers].sort((a, b) => b.min_points - a.min_points);
    return sortedTiers.find(tier => totalPoints >= tier.min_points) || program.tiers[0];
  };

  // Get tier discount
  const getTierDiscount = (tier: string): number => {
    if (!program) return 0;
    const tierData = program.tiers.find(t => t.name === tier);
    return tierData?.discount_percent || 0;
  };

  // Earn points mutation
  const earnPointsMutation = useMutation({
    mutationFn: async ({
      contactId,
      transactionId,
      amount,
    }: {
      contactId: string;
      transactionId: string;
      amount: number;
    }) => {
      if (!program) throw new Error("No loyalty program");

      const loyalty = await ensureCustomerLoyalty(contactId);
      const pointsEarned = calculatePoints(amount);

      // Update customer loyalty
      const newTotal = loyalty.points_earned_total + pointsEarned;
      const newTier = getTierForPoints(newTotal);

      const { error: updateError } = await supabase
        .from("customer_loyalty")
        .update({
          points_balance: loyalty.points_balance + pointsEarned,
          points_earned_total: newTotal,
          current_tier: newTier.name,
          total_spent: loyalty.total_spent + amount,
          visit_count: loyalty.visit_count + 1,
          last_visit: new Date().toISOString(),
        })
        .eq("id", loyalty.id);

      if (updateError) throw updateError;

      // Record transaction
      const { error: txError } = await supabase
        .from("loyalty_transactions")
        .insert({
          customer_loyalty_id: loyalty.id,
          pos_transaction_id: transactionId,
          points_change: pointsEarned,
          transaction_type: "earned",
          description: `Earned ${pointsEarned} points from purchase`,
        });

      if (txError) throw txError;

      return { pointsEarned, newTier: newTier.name };
    },
    onSuccess: (data) => {
      toast.success(`Customer earned ${data.pointsEarned} loyalty points!`);
      queryClient.invalidateQueries({ queryKey: ["customer-loyalty"] });
    },
  });

  // Redeem points mutation
  const redeemPointsMutation = useMutation({
    mutationFn: async ({
      contactId,
      transactionId,
      points,
    }: {
      contactId: string;
      transactionId?: string;
      points: number;
    }) => {
      if (!program) throw new Error("No loyalty program");

      const loyalty = await fetchCustomerLoyalty(contactId);
      if (!loyalty) throw new Error("Customer not enrolled in loyalty program");
      if (loyalty.points_balance < points) throw new Error("Insufficient points");
      if (points < program.minimum_points_redemption) {
        throw new Error(`Minimum ${program.minimum_points_redemption} points required for redemption`);
      }

      const cashValue = calculatePointsValue(points);

      // Update customer loyalty
      const { error: updateError } = await supabase
        .from("customer_loyalty")
        .update({
          points_balance: loyalty.points_balance - points,
          points_redeemed_total: loyalty.points_redeemed_total + points,
        })
        .eq("id", loyalty.id);

      if (updateError) throw updateError;

      // Record transaction
      const { error: txError } = await supabase
        .from("loyalty_transactions")
        .insert({
          customer_loyalty_id: loyalty.id,
          pos_transaction_id: transactionId || null,
          points_change: -points,
          transaction_type: "redeemed",
          description: `Redeemed ${points} points for ${cashValue.toFixed(2)} discount`,
        });

      if (txError) throw txError;

      return { pointsRedeemed: points, cashValue };
    },
    onSuccess: (data) => {
      toast.success(`Redeemed ${data.pointsRedeemed} points for ${data.cashValue.toFixed(2)} discount`);
      queryClient.invalidateQueries({ queryKey: ["customer-loyalty"] });
    },
  });

  // Adjust points mutation (for manual adjustments)
  const adjustPointsMutation = useMutation({
    mutationFn: async ({
      contactId,
      points,
      reason,
    }: {
      contactId: string;
      points: number;
      reason: string;
    }) => {
      if (!program) throw new Error("No loyalty program");

      const loyalty = await ensureCustomerLoyalty(contactId);
      const newBalance = loyalty.points_balance + points;
      if (newBalance < 0) throw new Error("Cannot adjust below zero");

      const newTotal = points > 0 ? loyalty.points_earned_total + points : loyalty.points_earned_total;
      const newTier = getTierForPoints(newTotal);

      const { error: updateError } = await supabase
        .from("customer_loyalty")
        .update({
          points_balance: newBalance,
          points_earned_total: newTotal,
          current_tier: newTier.name,
        })
        .eq("id", loyalty.id);

      if (updateError) throw updateError;

      const { error: txError } = await supabase
        .from("loyalty_transactions")
        .insert({
          customer_loyalty_id: loyalty.id,
          points_change: points,
          transaction_type: "adjusted",
          description: reason,
        });

      if (txError) throw txError;

      return { newBalance, newTier: newTier.name };
    },
    onSuccess: () => {
      toast.success("Points adjusted successfully");
      queryClient.invalidateQueries({ queryKey: ["customer-loyalty"] });
    },
  });

  return {
    // Active program (for POS)
    program,
    programLoading,
    
    // All programs (for settings)
    allPrograms,
    allProgramsLoading,
    
    // CRUD operations
    createProgram: createProgramMutation.mutateAsync,
    updateProgram: updateProgramMutation.mutateAsync,
    deleteProgram: deleteProgramMutation.mutateAsync,
    toggleProgram: toggleProgramMutation.mutateAsync,
    isCreating: createProgramMutation.isPending,
    isUpdating: updateProgramMutation.isPending,
    isDeleting: deleteProgramMutation.isPending,
    
    // Customer operations
    fetchCustomerLoyalty,
    ensureCustomerLoyalty,
    calculatePoints,
    calculatePointsValue,
    getTierForPoints,
    getTierDiscount,
    earnPoints: earnPointsMutation.mutateAsync,
    redeemPoints: redeemPointsMutation.mutateAsync,
    adjustPoints: adjustPointsMutation.mutateAsync,
    isEarning: earnPointsMutation.isPending,
    isRedeeming: redeemPointsMutation.isPending,
  };
}
