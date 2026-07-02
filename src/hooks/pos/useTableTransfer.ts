import { normalizeError } from "@/services/resilience";
/**
 * Table Transfer Hook
 * 
 * Manages merging tables and transferring items between table sessions.
 * Uses atomic Postgres RPCs to prevent partial-failure inconsistency.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export type TransferType = "merge" | "transfer_items" | "move_session";

export interface TableTransfer {
  id: string;
  organization_id: string;
  transfer_type: TransferType;
  source_session_id: string;
  target_session_id: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  items?: TransferItem[];
}

export interface TransferItem {
  id: string;
  transfer_id: string;
  transaction_item_id: string;
  quantity: number;
}

export function useTableTransfer() {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["pos-transactions"] });
    queryClient.invalidateQueries({ queryKey: ["table-order"] });
  };

  // Merge two table sessions (combine orders) — atomic RPC
  const mergeTables = useMutation({
    mutationFn: async ({
      sourceSessionId,
      targetSessionId,
      notes,
    }: {
      sourceSessionId: string;
      targetSessionId: string;
      notes?: string;
    }) => {
      if (!orgId) throw new Error("No organization selected");
      
      const { data: user } = await supabase.auth.getUser();
      
      const { data, error } = await supabase.rpc(
        "merge_table_orders" as any,
        {
          p_organization_id: orgId,
          p_source_session_id: sourceSessionId,
          p_target_session_id: targetSessionId,
          p_user_id: user.user?.id || null,
          p_notes: notes || null,
        }
      );

      if (error) throw error;
      
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Merge failed");
      }
      
      return result;
    },
    onSuccess: () => {
      invalidateAll();
      toast.success("Tables merged successfully");
    },
    onError: (error) => {
      toast.error("Failed to merge tables: " + normalizeError(error).message);
    },
  });

  // Transfer specific items between sessions — atomic RPC
  const transferItems = useMutation({
    mutationFn: async ({
      sourceSessionId,
      targetSessionId,
      itemsToTransfer,
      notes,
    }: {
      sourceSessionId: string;
      targetSessionId: string;
      itemsToTransfer: { transactionItemId: string; quantity: number }[];
      notes?: string;
    }) => {
      if (!orgId) throw new Error("No organization selected");
      
      const { data: user } = await supabase.auth.getUser();
      
      const { data, error } = await supabase.rpc(
        "transfer_table_items" as any,
        {
          p_organization_id: orgId,
          p_source_session_id: sourceSessionId,
          p_target_session_id: targetSessionId,
          p_items: itemsToTransfer.map(i => ({
            transaction_item_id: i.transactionItemId,
            quantity: i.quantity,
          })),
          p_user_id: user.user?.id || null,
          p_notes: notes || null,
        }
      );

      if (error) throw error;
      
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Transfer failed");
      }
      
      return result;
    },
    onSuccess: () => {
      invalidateAll();
      toast.success("Items transferred successfully");
    },
    onError: (error) => {
      toast.error("Failed to transfer items: " + normalizeError(error).message);
    },
  });

  // Move entire session to different table (simple update, already atomic)
  const moveSession = useMutation({
    mutationFn: async ({
      sessionId,
      newTableId,
      notes,
    }: {
      sessionId: string;
      newTableId: string;
      notes?: string;
    }) => {
      if (!orgId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected");
      
      const { data: user } = await supabase.auth.getUser();
      
      const { data, error } = await supabase
        .from("pos_table_sessions")
        .update({ table_id: newTableId })
        .eq("id", sessionId)
        .select()
        .single();
      
      if (error) throw error;
      
      // Record the move
      await supabase.from("pos_table_transfers").insert({
        organization_id: orgId,
        business_id: businessId,
        transfer_type: "move_session",
        source_session_id: sessionId,
        target_session_id: sessionId,
        notes: notes || `Moved to new table`,
        created_by: user.user?.id,
      });
      
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-tables"] });
      toast.success("Session moved to new table");
    },
    onError: (error) => {
      toast.error("Failed to move session: " + normalizeError(error).message);
    },
  });

  return {
    mergeTables,
    transferItems,
    moveSession,
  };
}
