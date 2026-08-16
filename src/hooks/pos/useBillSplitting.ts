import { normalizeError } from "@/services/resilience";
/**
 * Bill Splitting Hook — Phase 8 (server money authority + concurrency).
 *
 * The browser never computes, stores or overwrites a portion amount.
 * Every mutation is a SECURITY DEFINER RPC that:
 *   - re-derives the portion amount from the order's own lines,
 *   - refuses to assign more of a line than the order contains,
 *   - locks the portion row so a portion can only be paid once — a second
 *     terminal receives `{ success: false, conflict: true }` instead of
 *     silently double-paying.
 * Client keeps SELECT access only (writes are revoked at the grant level).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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

/** Thrown when the server reports another terminal got there first. */
export class SplitBillConflictError extends Error {
  readonly conflict = true;
  constructor(message: string) {
    super(message);
    this.name = "SplitBillConflictError";
  }
}

const CONFLICT_COPY: Record<string, string> = {
  portion_already_paid: "That portion was already paid on another terminal.",
  split_bill_has_paid_portions: "This bill already has paid portions and can no longer be re-split.",
  over_assigned: "That item is already fully assigned to other portions.",
};

function unwrap(data: unknown): any {
  const result = data as any;
  if (!result?.success) {
    const code = result?.error || "operation_failed";
    const message = CONFLICT_COPY[code] ?? code;
    if (result?.conflict) throw new SplitBillConflictError(message);
    throw new Error(message);
  }
  return result;
}

export function useBillSplitting(tableSessionId?: string) {
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const businessId = currentBusiness?.id;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["pos-split-bill"] });
    queryClient.invalidateQueries({ queryKey: ["table-order"] });
  };

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

  const createSplitBill = useMutation({
    mutationFn: async (input: CreateSplitBillInput) => {
      const { data, error } = await supabase.rpc("create_pos_split_bill" as never, {
        p_table_session_id: input.table_session_id,
        p_split_type: input.split_type,
        p_split_count: input.split_count,
      } as never);
      if (error) throw error;
      return unwrap(data);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Bill split created");
    },
    onError: (error) => {
      toast.error("Failed to create split bill: " + normalizeError(error).message);
    },
  });

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
      const { data, error } = await supabase.rpc("assign_pos_split_item" as never, {
        p_portion_id: portionId,
        p_transaction_item_id: transactionItemId,
        p_quantity: quantity,
      } as never);
      if (error) throw error;
      return unwrap(data);
    },
    onSuccess: invalidate,
    onError: (error) => {
      toast.error("Failed to assign item: " + normalizeError(error).message);
    },
  });

  const removeItemFromPortion = useMutation({
    mutationFn: async (splitBillItemId: string) => {
      const { data, error } = await supabase.rpc("remove_pos_split_item" as never, {
        p_split_bill_item_id: splitBillItemId,
      } as never);
      if (error) throw error;
      return unwrap(data);
    },
    onSuccess: invalidate,
    onError: (error) => {
      toast.error("Failed to remove item: " + normalizeError(error).message);
    },
  });

  const markPortionPaid = useMutation({
    mutationFn: async ({ portionId, transactionId }: { portionId: string; transactionId?: string }) => {
      const { data, error } = await supabase.rpc("pay_pos_split_portion" as never, {
        p_portion_id: portionId,
        p_transaction_id: transactionId ?? null,
      } as never);
      if (error) throw error;
      return unwrap(data);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Portion marked as paid");
    },
    onError: (error) => {
      toast.error("Failed to mark as paid: " + normalizeError(error).message);
    },
  });

  const cancelSplitBill = useMutation({
    mutationFn: async (splitBillId: string) => {
      const { data, error } = await supabase.rpc("cancel_pos_split_bill" as never, {
        p_split_bill_id: splitBillId,
      } as never);
      if (error) throw error;
      return unwrap(data);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Split bill cancelled");
    },
    onError: (error) => {
      toast.error("Failed to cancel split bill: " + normalizeError(error).message);
    },
  });

  const isFullyPaid = (): boolean => {
    if (!splitBillQuery.data?.portions) return false;
    return splitBillQuery.data.portions.every((p) => p.status === "paid");
  };

  const getUnpaidPortions = (): SplitBillPortion[] => {
    if (!splitBillQuery.data?.portions) return [];
    return splitBillQuery.data.portions.filter((p) => p.status === "pending");
  };

  return {
    splitBill: splitBillQuery.data,
    isLoading: splitBillQuery.isLoading,
    createSplitBill,
    assignItemToPortion,
    removeItemFromPortion,
    markPortionPaid,
    cancelSplitBill,
    isFullyPaid,
    getUnpaidPortions,
  };
}
