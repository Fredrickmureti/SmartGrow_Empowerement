import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { CartState } from "./usePOSCart";
import { normalizeError } from "@/services/resilience";

export interface HeldTransaction {
  id: string;
  register_id: string;
  shift_id: string | null;
  customer_name: string | null;
  items: CartState;
  held_at: string;
  held_by: string | null;
  notes: string | null;
  status: "held" | "resumed" | "cancelled";
}

/**
 * Held (parked) orders — Phase 8 (concurrency & idempotency).
 *
 * Every mutation goes through a SECURITY DEFINER RPC:
 *  - `hold_pos_transaction`    — server re-prices the basket with
 *    `pos_quote_cart`; the browser's subtotal is never stored.
 *  - `recall_pos_held_transaction` — status/shift guarded; the losing
 *    terminal in a double-recall gets `held_order_already_resumed`.
 *  - `cancel_pos_held_transaction` — refuses to cancel an order that a
 *    second terminal already recalled.
 * The client keeps read access only; it performs no money math here.
 */
export function usePOSHeldTransactions(registerId?: string) {
  const { currentBusiness } = useBusinesses();
  // Stage R7 — register_id implies a branch, but we add an explicit
  // branch filter so the query cache key is invalidated on branch switch
  // and so a regressed UI that drops the registerId filter still won't leak.
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: heldTransactions = [], isLoading } = useQuery({
    queryKey: ["pos-held-transactions", registerId, businessId, branchId],
    queryFn: async () => {
      if (!registerId || !businessId) return [];

      let q = supabase
        .from("pos_held_transactions")
        .select("*")
        .eq("register_id", registerId)
        .eq("business_id", businessId)
        .eq("status", "held");
      if (branchId) q = q.eq("branch_id", branchId);

      const { data, error } = await q.order("held_at", { ascending: false });

      if (error) throw error;

      return data.map((tx) => ({
        ...tx,
        items: tx.items as unknown as CartState,
        status: tx.status as "held" | "resumed" | "cancelled",
      })) as HeldTransaction[];
    },
    enabled: !!registerId && !!businessId,
  });

  const holdTransaction = useMutation({
    mutationFn: async (data: {
      register_id: string;
      shift_id: string;
      /** Accepted for call-site compatibility; the server derives scope. */
      organization_id?: string;
      cart: CartState;
      notes?: string;
    }) => {
      if (!user?.id) throw new Error("Not authenticated");

      const { data: result, error } = await supabase.rpc(
        "hold_pos_transaction" as never,
        {
          p_register_id: data.register_id,
          p_shift_id: data.shift_id,
          p_cart: data.cart as never,
          p_notes: data.notes ?? null,
        } as never,
      );
      if (error) throw error;
      return result as unknown as HeldTransaction;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-held-transactions"] });
      toast.success("Transaction held successfully");
    },
    onError: (error: Error) => {
      toast.error(`Failed to hold transaction: ${normalizeError(error).message}`);
    },
  });

  const resumeTransaction = useMutation({
    mutationFn: async (input: string | { id: string; shiftId: string }) => {
      const heldId = typeof input === "string" ? input : input.id;
      let shiftId = typeof input === "string" ? undefined : input.shiftId;

      // Callers that only know the held id (older dialogs) resolve the shift
      // from the row itself — the RPC still enforces open-shift / same-shift.
      if (!shiftId) {
        const { data: row, error: rowErr } = await supabase
          .from("pos_held_transactions")
          .select("shift_id")
          .eq("id", heldId)
          .single();
        if (rowErr) throw rowErr;
        shiftId = row.shift_id as string;
      }

      const { data, error } = await supabase.rpc(
        "recall_pos_held_transaction" as never,
        { p_held_id: heldId, p_shift_id: shiftId } as never,
      );
      if (error) throw error;
      const row = data as any;
      return { ...row, items: row.items as unknown as CartState };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-held-transactions"] });
      toast.success("Transaction resumed");
    },
    onError: (error: Error) => {
      toast.error(`Failed to resume transaction: ${normalizeError(error).message}`);
    },
  });

  const cancelHeldTransaction = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc(
        "cancel_pos_held_transaction" as never,
        { p_held_id: id } as never,
      );
      if (error) throw error;
      return data as unknown as HeldTransaction;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-held-transactions"] });
      toast.success("Held transaction cancelled");
    },
    onError: (error: Error) => {
      toast.error(`Failed to cancel: ${normalizeError(error).message}`);
    },
  });

  return {
    heldTransactions,
    heldCount: heldTransactions.length,
    isLoading,
    holdTransaction,
    resumeTransaction,
    cancelHeldTransaction,
  };
}
