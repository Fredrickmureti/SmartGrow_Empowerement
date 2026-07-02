import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { CartState } from "./usePOSCart";
import { Json } from "@/integrations/supabase/types";
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

export function usePOSHeldTransactions(registerId?: string) {
  const { currentOrg } = useOrganization();
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
      organization_id: string;
      cart: CartState;
      notes?: string;
    }) => {
      if (!user?.id) throw new Error("Not authenticated");
      if (!businessId) throw new Error("No company selected");

      // Look up register's branch so held transaction inherits it correctly.
      const { data: register, error: regErr } = await supabase
        .from("pos_registers")
        .select("branch_id, business_id")
        .eq("id", data.register_id)
        .eq("business_id", businessId)
        .single();
      if (regErr) throw regErr;

      const { data: result, error } = await supabase
        .from("pos_held_transactions")
        .insert({
          organization_id: data.organization_id,
          business_id: businessId,
          branch_id: register.branch_id,
          register_id: data.register_id,
          shift_id: data.shift_id,
          customer_name: data.cart.customer?.name || null,
          subtotal: data.cart.subtotal,
          items: data.cart as unknown as Json,
          held_by: user.id,
          notes: data.notes || null,
          status: "held",
        })
        .select()
        .single();

      if (error) throw error;
      return result;
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
      if (!businessId) throw new Error("No company selected");
      // Stage D: recall via RPC so server enforces same-shift, open-shift rule.
      // Backwards-compat: callers that pass a bare id fall back to the legacy
      // direct-update path (still RLS-guarded by business scope).
      if (typeof input === "object" && input.id && input.shiftId) {
        const { data, error } = await supabase.rpc(
          "recall_pos_held_transaction" as any,
          { p_held_id: input.id, p_shift_id: input.shiftId }
        );
        if (error) throw error;
        const row = data as any;
        return { ...row, items: row.items as unknown as CartState };
      }

      const id = typeof input === "string" ? input : input.id;
      const { data, error } = await supabase
        .from("pos_held_transactions")
        .update({ status: "resumed" })
        .eq("id", id)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) throw error;
      return {
        ...data,
        items: data.items as unknown as CartState,
      };
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
      if (!businessId) throw new Error("No company selected");
      const { error } = await supabase
        .from("pos_held_transactions")
        .update({ status: "cancelled" })
        .eq("id", id)
        .eq("business_id", businessId);

      if (error) throw error;
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
