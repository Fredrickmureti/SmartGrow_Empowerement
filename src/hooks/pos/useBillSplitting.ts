import { normalizeError } from "@/services/resilience";
/**
 * Bill Splitting Hook
 * 
 * Manages splitting bills by item, seat, or equal parts for restaurant mode.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";

export type SplitType = "by_item" | "by_seat" | "equal" | "custom";
export type PortionStatus = "pending" | "paid" | "cancelled";

export interface SplitBill {
  id: string;
  organization_id: string;
  table_session_id: string;
  split_type: SplitType;
  split_count: number;
  created_at: string;
  created_by: string | null;
  portions?: SplitBillPortion[];
}

export interface SplitBillPortion {
  id: string;
  split_bill_id: string;
  portion_number: number;
  seat_label: string | null;
  amount: number;
  status: PortionStatus;
  transaction_id: string | null;
  paid_at: string | null;
  items?: SplitBillItem[];
}

export interface SplitBillItem {
  id: string;
  portion_id: string;
  transaction_item_id: string;
  quantity: number;
}

export interface CreateSplitBillInput {
  table_session_id: string;
  split_type: SplitType;
  split_count: number;
}

export function useBillSplitting(tableSessionId?: string) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch split bill for a table session — defense-in-depth: filter by business_id too
  const splitBillQuery = useQuery({
    queryKey: ["pos-split-bill", tableSessionId, businessId],
    queryFn: async () => {
      if (!tableSessionId || !businessId) return null;

      const { data, error } = await supabase
        .from("pos_split_bills")
        .select(`
          *,
          portions:pos_split_bill_portions(
            *,
            items:pos_split_bill_items(*)
          )
        `)
        .eq("table_session_id", tableSessionId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data as SplitBill | null;
    },
    enabled: !!tableSessionId && !!businessId,
  });

  // Create split bill
  const createSplitBill = useMutation({
    mutationFn: async (input: CreateSplitBillInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected");

      const { data: user } = await supabase.auth.getUser();

      // Look up the parent session's branch so the split bill inherits it.
      const { data: session, error: sessionErr } = await supabase
        .from("pos_table_sessions")
        .select("branch_id, business_id")
        .eq("id", input.table_session_id)
        .eq("business_id", businessId)
        .single();
      if (sessionErr) throw sessionErr;

      // Create the split bill (business_id is now NOT NULL + trigger-validated)
      const { data: splitBill, error: splitError } = await supabase
        .from("pos_split_bills")
        .insert({
          organization_id: orgId,
          business_id: businessId,
          branch_id: session.branch_id,
          table_session_id: input.table_session_id,
          split_type: input.split_type,
          split_count: input.split_count,
          created_by: user.user?.id,
        })
        .select()
        .single();
      
      if (splitError) throw splitError;
      
      // Create portions
      const portions = Array.from({ length: input.split_count }, (_, i) => ({
        split_bill_id: splitBill.id,
        portion_number: i + 1,
        seat_label: input.split_type === "by_seat" ? `Seat ${i + 1}` : null,
        amount: 0,
        status: "pending" as const,
      }));
      
      const { error: portionsError } = await supabase
        .from("pos_split_bill_portions")
        .insert(portions);
      
      if (portionsError) throw portionsError;
      
      return splitBill;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-split-bill", tableSessionId] });
      toast.success("Bill split created");
    },
    onError: (error) => {
      toast.error("Failed to create split bill: " + normalizeError(error).message);
    },
  });

  // Assign item to portion
  const assignItemToPortion = useMutation({
    mutationFn: async ({
      portionId,
      transactionItemId,
      quantity,
    }: {
      portionId: string;
      transactionItemId: string;
      quantity: number;
    }) => {
      const { data, error } = await supabase
        .from("pos_split_bill_items")
        .insert({
          portion_id: portionId,
          transaction_item_id: transactionItemId,
          quantity,
        })
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-split-bill", tableSessionId] });
    },
    onError: (error) => {
      toast.error("Failed to assign item: " + normalizeError(error).message);
    },
  });

  // Remove item from portion
  const removeItemFromPortion = useMutation({
    mutationFn: async (splitBillItemId: string) => {
      const { error } = await supabase
        .from("pos_split_bill_items")
        .delete()
        .eq("id", splitBillItemId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-split-bill", tableSessionId] });
    },
    onError: (error) => {
      toast.error("Failed to remove item: " + normalizeError(error).message);
    },
  });

  // Update portion amount
  const updatePortionAmount = useMutation({
    mutationFn: async ({ portionId, amount }: { portionId: string; amount: number }) => {
      const { data, error } = await supabase
        .from("pos_split_bill_portions")
        .update({ amount })
        .eq("id", portionId)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-split-bill", tableSessionId] });
    },
    onError: (error) => {
      toast.error("Failed to update amount: " + normalizeError(error).message);
    },
  });

  // Mark portion as paid
  const markPortionPaid = useMutation({
    mutationFn: async ({ portionId, transactionId }: { portionId: string; transactionId?: string }) => {
      const { data, error } = await supabase
        .from("pos_split_bill_portions")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          transaction_id: transactionId || null,
        })
        .eq("id", portionId)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-split-bill", tableSessionId] });
      toast.success("Portion marked as paid");
    },
    onError: (error) => {
      toast.error("Failed to mark as paid: " + normalizeError(error).message);
    },
  });

  // Cancel split bill
  const cancelSplitBill = useMutation({
    mutationFn: async (splitBillId: string) => {
      const { error } = await supabase
        .from("pos_split_bills")
        .delete()
        .eq("id", splitBillId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-split-bill", tableSessionId] });
      toast.success("Split bill cancelled");
    },
    onError: (error) => {
      toast.error("Failed to cancel split bill: " + normalizeError(error).message);
    },
  });

  // Calculate equal split amounts
  const calculateEqualSplit = (totalAmount: number, splitCount: number): number[] => {
    const baseAmount = Math.floor((totalAmount / splitCount) * 100) / 100;
    const remainder = Math.round((totalAmount - baseAmount * splitCount) * 100) / 100;
    
    const amounts = Array(splitCount).fill(baseAmount);
    if (remainder > 0) {
      amounts[0] = Math.round((amounts[0] + remainder) * 100) / 100;
    }
    
    return amounts;
  };

  // Check if all portions are paid
  const isFullyPaid = (): boolean => {
    if (!splitBillQuery.data?.portions) return false;
    return splitBillQuery.data.portions.every(p => p.status === "paid");
  };

  // Get unpaid portions
  const getUnpaidPortions = (): SplitBillPortion[] => {
    if (!splitBillQuery.data?.portions) return [];
    return splitBillQuery.data.portions.filter(p => p.status === "pending");
  };

  return {
    splitBill: splitBillQuery.data,
    isLoading: splitBillQuery.isLoading,
    createSplitBill,
    assignItemToPortion,
    removeItemFromPortion,
    updatePortionAmount,
    markPortionPaid,
    cancelSplitBill,
    calculateEqualSplit,
    isFullyPaid,
    getUnpaidPortions,
  };
}
