import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface ReconciliationItem {
  id: string;
  session_id: string;
  transaction_id: string;
  status: "cleared" | "uncleared";
  cleared_at: string | null;
  cleared_by: string | null;
}

/**
 * Server-computed reconciliation arithmetic, returned by every mutating RPC.
 * The browser never derives these numbers itself any more.
 */
export interface ReconciliationCalc {
  session_id: string;
  cleared_count: number;
  cleared_movement: number;
  reconciled_balance: number;
  cleared_balance: number;
  difference: number;
  is_balanced: boolean;
}

/**
 * Phase 4 (Banking reconstruction) — cleared items are written by the
 * `bank_reconciliation_item_set` RPC, never by the browser. The RPC validates
 * that the session is still in progress, that the line belongs to the same
 * bank account, that it is dated on or before the statement date and that it
 * is not already reconciled, then returns the recomputed session arithmetic.
 */
export function useReconciliationItems(sessionId: string | null) {
  const [clearedIds, setClearedIds] = useState<Set<string>>(new Set());
  const [calc, setCalc] = useState<ReconciliationCalc | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadItems = useCallback(async () => {
    if (!sessionId) return;
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("bank_reconciliation_items")
        .select("transaction_id, status")
        .eq("session_id", sessionId)
        .eq("status", "cleared");

      if (error) throw error;
      const ids = new Set<string>((data || []).map((item: any) => item.transaction_id as string));
      setClearedIds(ids);
    } catch (error) {
      console.error("Error loading reconciliation items:", error);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const toggleCleared = useCallback(async (transactionId: string) => {
    if (!sessionId) return;
    const nextCleared = !clearedIds.has(transactionId);
    setIsSaving(true);

    try {
      const { data, error } = await (supabase as any).rpc("bank_reconciliation_item_set", {
        _session_id: sessionId,
        _transaction_id: transactionId,
        _cleared: nextCleared,
      });
      if (error) throw error;

      setClearedIds(prev => {
        const next = new Set(prev);
        if (nextCleared) next.add(transactionId);
        else next.delete(transactionId);
        return next;
      });
      if (data) setCalc(data as ReconciliationCalc);
    } catch (error) {
      console.error("Error toggling reconciliation item:", error);
      const msg = (error as { message?: string })?.message ?? "";
      toast.error(msg || "Failed to update cleared status");
      // Server rejected the change — resync from the source of truth.
      loadItems();
    } finally {
      setIsSaving(false);
    }
  }, [sessionId, clearedIds, loadItems]);

  return {
    clearedIds,
    calc,
    isLoading,
    isSaving,
    toggleCleared,
    reload: loadItems,
  };
}
