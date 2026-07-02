import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";
import { useBranch } from "@/contexts/BranchContext";
import { isOverrideRequiredError } from "@/hooks/pos/usePOSSecuritySettings";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface VoidTransactionData {
  transaction_id: string;
  void_reason_id: string;
  void_note?: string;
  override_id?: string;
}

export function usePOSVoid() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();

  const voidTransaction = useMutation({
    mutationFn: async (data: VoidTransactionData) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      if (!currentBusiness?.id) throw new Error("No company selected");

      // Defense-in-depth: confirm the transaction belongs to the active
      // company AND active branch. The server-side override-matrix check
      // also enforces this, but the client-side .eq("branch_id", …) makes a
      // context-switch race fail fast instead of silently 42501-ing later.
      let txQuery = supabase
        .from("pos_transactions")
        .select("id")
        .eq("id", data.transaction_id)
        .eq("business_id", currentBusiness.id);
      if (currentBranch?.id) txQuery = txQuery.eq("branch_id", currentBranch.id);
      const { data: tx, error: txErr } = await txQuery.maybeSingle();
      if (txErr) throw txErr;
      if (!tx) {
        throw new Error(
          currentBranch?.id
            ? "Transaction not found in the active branch — switch to the originating branch to void."
            : "Transaction not found in the active company",
        );
      }

      const { data: result, error } = await supabase.rpc("process_pos_void", {
        p_organization_id: currentOrg.id,
        p_transaction_id: data.transaction_id,
        p_void_reason_id: data.void_reason_id,
        p_void_note: data.void_note ?? null,
        p_voided_by: user.id,
        p_override_id: data.override_id ?? null,
      } as any);

      if (error) throw error;

      const rpcResult = result as any;
      if (!rpcResult?.success) {
        const err: any = new Error(rpcResult?.details || rpcResult?.error || "Void failed");
        err.code = rpcResult?.error;
        throw err;
      }

      return {
        transactionId: rpcResult.transaction_id as string,
        transactionNumber: rpcResult.transaction_number as string,
        voidedAmount: rpcResult.voided_amount as number,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["pos-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success(`Transaction ${result.transactionNumber} voided`);
    },
    onError: (error: Error) => {
      // Stage 8.6: callers handle override_required by opening the PIN dialog;
      // suppress the toast so the cashier doesn't see a raw SQL message.
      if (isOverrideRequiredError(error)) return;
      toast.error(normalizeError(error).message);
    },
  });

  return { voidTransaction };
}
