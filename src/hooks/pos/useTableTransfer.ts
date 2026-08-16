import { normalizeError } from "@/services/resilience";
/**
 * Table Transfer Hook — Phase 8 (concurrency & idempotency).
 *
 * Merge, item transfer and table move are atomic SECURITY DEFINER RPCs.
 * The server derives company/branch from the session (never from the
 * browser), re-totals both orders from their own lines, and honours an
 * optional expected-version guard: when a second terminal changed the
 * order first, the RPC returns `{ success: false, conflict: true }`
 * instead of overwriting it.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
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

/** Thrown when another terminal changed the order first. */
export class TableTransferConflictError extends Error {
  readonly conflict = true;
  constructor(message: string) {
    super(message);
    this.name = "TableTransferConflictError";
  }
}

const CONFLICT_COPY: Record<string, string> = {
  source_order_changed: "This table's order changed on another terminal — reload and try again.",
  target_order_changed: "The destination order changed on another terminal — reload and try again.",
  item_no_longer_on_source_order: "One of the items was already moved on another terminal.",
  target_table_occupied: "That table already has an open order.",
  session_already_closed: "This table session was already closed.",
  order_changed: "This order changed on another terminal — reload and try again.",
};

function unwrap(data: unknown, fallback: string): any {
  const result = data as any;
  if (!result?.success) {
    const code = result?.error || fallback;
    const message = CONFLICT_COPY[code] ?? code;
    if (result?.conflict) throw new TableTransferConflictError(message);
    throw new Error(message);
  }
  return result;
}

export function useTableTransfer() {
  const { currentOrg } = useSession();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["pos-transactions"] });
    queryClient.invalidateQueries({ queryKey: ["table-order"] });
  };

  const mergeTables = useMutation({
    mutationFn: async ({
      sourceSessionId,
      targetSessionId,
      notes,
      expectedSourceVersion,
      expectedTargetVersion,
    }: {
      sourceSessionId: string;
      targetSessionId: string;
      notes?: string;
      expectedSourceVersion?: number;
      expectedTargetVersion?: number;
    }) => {
      if (!orgId) throw new Error("No organization selected");

      const { data, error } = await supabase.rpc("merge_table_orders" as never, {
        p_organization_id: orgId,
        p_source_session_id: sourceSessionId,
        p_target_session_id: targetSessionId,
        p_user_id: null,
        p_notes: notes || null,
        p_expected_source_version: expectedSourceVersion ?? null,
        p_expected_target_version: expectedTargetVersion ?? null,
      } as never);

      if (error) throw error;
      return unwrap(data, "merge_failed");
    },
    onSuccess: () => {
      invalidateAll();
      toast.success("Tables merged successfully");
    },
    onError: (error) => {
      toast.error("Failed to merge tables: " + normalizeError(error).message);
    },
  });

  const transferItems = useMutation({
    mutationFn: async ({
      sourceSessionId,
      targetSessionId,
      itemsToTransfer,
      notes,
      expectedSourceVersion,
      expectedTargetVersion,
    }: {
      sourceSessionId: string;
      targetSessionId: string;
      itemsToTransfer: { transactionItemId: string; quantity: number }[];
      notes?: string;
      expectedSourceVersion?: number;
      expectedTargetVersion?: number;
    }) => {
      if (!orgId) throw new Error("No organization selected");

      const { data, error } = await supabase.rpc("transfer_table_items" as never, {
        p_organization_id: orgId,
        p_source_session_id: sourceSessionId,
        p_target_session_id: targetSessionId,
        p_items: itemsToTransfer.map((i) => ({
          transaction_item_id: i.transactionItemId,
          quantity: i.quantity,
        })),
        p_notes: notes || null,
        p_user_id: null,
        p_expected_source_version: expectedSourceVersion ?? null,
        p_expected_target_version: expectedTargetVersion ?? null,
      } as never);

      if (error) throw error;
      return unwrap(data, "transfer_failed");
    },
    onSuccess: () => {
      invalidateAll();
      toast.success("Items transferred successfully");
    },
    onError: (error) => {
      toast.error("Failed to transfer items: " + normalizeError(error).message);
    },
  });

  const moveSession = useMutation({
    mutationFn: async ({
      sessionId,
      newTableId,
      notes,
      expectedVersion,
    }: {
      sessionId: string;
      newTableId: string;
      notes?: string;
      expectedVersion?: number;
    }) => {
      const { data, error } = await supabase.rpc("move_pos_table_session" as never, {
        p_session_id: sessionId,
        p_new_table_id: newTableId,
        p_notes: notes || null,
        p_expected_version: expectedVersion ?? null,
      } as never);

      if (error) throw error;
      return unwrap(data, "move_failed");
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
