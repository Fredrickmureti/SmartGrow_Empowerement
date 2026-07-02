import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface InventoryReconciliationRow {
  account_id: string;
  account_code: string;
  account_name: string;
  subledger_value: number;
  gl_closing: number;
  drift: number;
}

/**
 * Compares the inventory subledger (Σ warehouse_stock × cost_price) against
 * the General Ledger closing balance of the configured Inventory control
 * account. A non-zero drift means an opening or revaluation journal is
 * missing — never silently patch the report; surface the drift and offer
 * the explicit `backfill_opening_inventory_gl` remediation.
 */
export function useInventoryReconciliation() {
  const { currentOrg } = useOrganization();

  return useQuery({
    queryKey: ["inventory-gl-reconciliation", currentOrg?.id],
    queryFn: async (): Promise<InventoryReconciliationRow[]> => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase as any).rpc(
        "reconcile_inventory_subledger_to_gl",
        { p_org: currentOrg.id },
      );
      if (error) throw error;
      return (data ?? []) as InventoryReconciliationRow[];
    },
    enabled: !!currentOrg?.id,
    staleTime: 30_000,
  });
}

export function useBackfillOpeningInventory() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<{ success?: boolean; skipped?: boolean; reason?: string; journal_entry_id?: string; total_posted?: number }> => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { data, error } = await (supabase as any).rpc(
        "backfill_opening_inventory_gl",
        { p_org: currentOrg.id },
      );
      if (error) throw error;
      return data ?? {};
    },
    onSuccess: (result) => {
      if (result.skipped) {
        toast.info(`Backfill skipped: ${result.reason}`);
      } else {
        toast.success(`Opening inventory journal posted (${result.total_posted?.toLocaleString()})`);
      }
      qc.invalidateQueries({ queryKey: ["inventory-gl-reconciliation"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["financial-report"] });
      qc.invalidateQueries({ queryKey: ["accounting-integrity-findings"] });
    },
    onError: (err: Error) => toast.error(`Backfill failed: ${normalizeError(err).message}`),
  });
}

export function useDetectNegativeAssets() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<number> => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { data, error } = await (supabase as any).rpc(
        "detect_negative_asset_findings",
        { p_org: currentOrg.id },
      );
      if (error) throw error;
      return (data as number) ?? 0;
    },
    onSuccess: (count) => {
      if (count > 0) toast.warning(`${count} new negative-asset finding(s) recorded`);
      else toast.success("No negative asset balances detected");
      qc.invalidateQueries({ queryKey: ["accounting-integrity-findings"] });
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });
}
