import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { POSTransactionItem } from "./usePOSTransactionHistory";
import { normalizeError } from "@/services/resilience";

export interface ReturnItem {
  original_item_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  return_reason_id: string;
  return_reason_note?: string | null;
  cost_price?: number;
}

export interface ProcessReturnData {
  register_id: string;
  shift_id: string;
  original_transaction_id: string;
  items: ReturnItem[];
  refund_method: "cash" | "card" | "store_credit";
  notes?: string;
  /** Stage 4 closeout: required when the refund tender differs from the
   *  original payment tender(s). Server re-validates. */
  override_id?: string | null;
}

/**
 * Stage 4: returns engine. The DB RPC `process_pos_return` is the only path
 * that mutates pos_transactions/pos_transaction_items/stock_movements for a
 * return. This hook is a thin client over it that:
 *   - enforces every line carries `original_item_id` + `return_reason_id`
 *   - sends `return_reason_note` only when the reason requires it
 *   - never trusts the client for price/tax (RPC reads from snapshot view)
 */
export function usePOSReturns() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const processReturn = useMutation({
    mutationFn: async (data: ProcessReturnData) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      if (!currentBusiness?.id) throw new Error("No company selected");

      if (data.items.length === 0) {
        throw new Error("Select at least one item to return");
      }
      for (const item of data.items) {
        if (!item.original_item_id) throw new Error("Each return line must reference the original item");
        if (!item.return_reason_id) throw new Error("Each return line requires a reason");
        if (item.quantity <= 0) throw new Error("Return quantity must be greater than zero");
      }

      // Defense-in-depth: confirm the original transaction belongs to the
      // active company. The DB RPC also enforces this.
      const { data: origTx, error: origErr } = await supabase
        .from("pos_transactions")
        .select("business_id")
        .eq("id", data.original_transaction_id)
        .eq("business_id", currentBusiness.id)
        .maybeSingle();
      if (origErr) throw origErr;
      if (!origTx) {
        throw new Error("Original transaction not found in the active company");
      }

      const { data: result, error } = await supabase.rpc(
        "process_pos_return" as any,
        {
          p_organization_id: currentOrg.id,
          p_register_id: data.register_id,
          p_shift_id: data.shift_id,
          p_original_transaction_id: data.original_transaction_id,
          p_items: data.items.map((item) => ({
            product_id: item.product_id,
            original_item_id: item.original_item_id,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate,
            cost_price: item.cost_price ?? null,
            return_reason_id: item.return_reason_id,
            return_reason_note: item.return_reason_note ?? null,
          })),
          p_refund_method: data.refund_method === "store_credit" ? "voucher" : data.refund_method,
          p_notes: data.notes || null,
          p_created_by: user.id,
          p_override_id: data.override_id ?? null,
        }
      );

      if (error) throw error;

      const rpcResult = result as any;

      if (!rpcResult?.success) {
        const errMsg = rpcResult?.details || rpcResult?.error || "Return processing failed";
        throw new Error(errMsg);
      }

      return {
        transaction: { id: rpcResult.transaction_id },
        transactionNumber: rpcResult.transaction_number,
        refundAmount: rpcResult.refund_amount,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["pos-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["pos-returnable-qty"] });
      toast.success(`Return processed: ${result.transactionNumber}`);
    },
    onError: (error: Error) => {
      toast.error(`Failed to process return: ${normalizeError(error).message}`);
    },
  });

  /**
   * Convert original transaction items to return items. Caller supplies
   * per-line quantity, reason id, and optional note. Lines with quantity 0
   * are filtered out. Math here is preview-only — server is authoritative.
   */
  const prepareReturnItems = (
    originalItems: POSTransactionItem[],
    quantities: Record<string, number>,
    reasonIds: Record<string, string>,
    reasonNotes: Record<string, string | undefined>
  ): ReturnItem[] => {
    return originalItems
      .filter((item) => quantities[item.id] && quantities[item.id] > 0)
      .map((item) => {
        const returnQty = quantities[item.id];
        const itemPrice = item.unit_price * returnQty;
        const taxAmount = itemPrice * (item.tax_rate / 100);

        return {
          original_item_id: item.id,
          product_id: item.product_id,
          description: item.description,
          quantity: returnQty,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          tax_amount: taxAmount,
          line_total: itemPrice + taxAmount,
          cost_price: item.cost_price,
          return_reason_id: reasonIds[item.id],
          return_reason_note: reasonNotes[item.id] || null,
        };
      });
  };

  return {
    processReturn,
    prepareReturnItems,
  };
}
