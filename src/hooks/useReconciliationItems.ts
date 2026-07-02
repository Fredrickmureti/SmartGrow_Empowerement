import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ReconciliationItem {
  id: string;
  session_id: string;
  transaction_id: string;
  status: "cleared" | "uncleared";
  cleared_at: string | null;
  cleared_by: string | null;
}

/**
 * Hook to persist reconciliation cleared items in the DB.
 * Replaces the ephemeral React useState<Set<string>> pattern.
 */
export function useReconciliationItems(sessionId: string | null) {
  const [clearedIds, setClearedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load cleared items for this session from DB
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

  // Toggle a transaction's cleared status, persisting to DB
  const toggleCleared = useCallback(async (transactionId: string) => {
    if (!sessionId) return;
    const isCurrentlyCleared = clearedIds.has(transactionId);
    setIsSaving(true);

    try {
      if (isCurrentlyCleared) {
        // Remove (delete the row)
        await supabase
          .from("bank_reconciliation_items")
          .delete()
          .eq("session_id", sessionId)
          .eq("transaction_id", transactionId);

        setClearedIds(prev => {
          const next = new Set(prev);
          next.delete(transactionId);
          return next;
        });
      } else {
        // Insert as cleared
        const { data: userData } = await supabase.auth.getUser();
        await supabase
          .from("bank_reconciliation_items")
          .upsert({
            session_id: sessionId,
            transaction_id: transactionId,
            status: "cleared",
            cleared_at: new Date().toISOString(),
            cleared_by: userData.user?.id || null,
          } as any, { onConflict: "session_id,transaction_id" });

        setClearedIds(prev => new Set(prev).add(transactionId));
      }
    } catch (error) {
      console.error("Error toggling reconciliation item:", error);
      // Revert optimistic update
      loadItems();
    } finally {
      setIsSaving(false);
    }
  }, [sessionId, clearedIds, loadItems]);

  // Batch mark all cleared items as reconciled in bank_transactions
  const markAllReconciled = useCallback(async () => {
    if (!sessionId || clearedIds.size === 0) return;

    const ids = Array.from(clearedIds);
    const { error } = await supabase
      .from("bank_transactions")
      .update({
        is_reconciled: true,
        reconciled_at: new Date().toISOString(),
        lifecycle_status: "reconciled",
        reconciliation_session_id: sessionId,
      } as any)
      .in("id", ids);

    if (error) {
      console.error("Error marking transactions reconciled:", error);
      throw error;
    }
  }, [sessionId, clearedIds]);

  return {
    clearedIds,
    isLoading,
    isSaving,
    toggleCleared,
    markAllReconciled,
    reload: loadItems,
  };
}
