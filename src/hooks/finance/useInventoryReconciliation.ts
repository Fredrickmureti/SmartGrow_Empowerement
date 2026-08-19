import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

/**
 * Inventory subledger ⇄ General Ledger control-account reconciliation.
 *
 * Contract (see ADR 0017):
 *  - Valuation basis is the per-warehouse moving-average cost
 *    (`warehouse_stock.average_cost`), falling back to `products.cost_price`.
 *    Fallback / zero-cost / negative-quantity lines are COUNTED and surfaced,
 *    never silently absorbed into the total.
 *  - The GL side is summed from POSTED `journal_entry_lines` up to an
 *    explicit as-at date — never from the denormalised
 *    `accounts.current_balance`, which cannot detect a stale cache.
 *  - Reading is read-only. Remediation is a separate, explicit, previewed,
 *    permission-gated action.
 */
export interface InventoryReconciliationRow {
  account_id: string;
  account_code: string;
  account_name: string;
  business_id: string | null;
  subledger_value: number;
  gl_closing: number;
  drift: number;
  fallback_cost_lines: number;
  zero_cost_lines: number;
  negative_qty_lines: number;
}

export interface NegativeStockPosition {
  product_id: string;
  product_name: string;
  sku: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  quantity: number;
  unit_cost: number;
  valuation_impact: number;
}

export interface SubledgerCompositionRow {
  warehouse_id: string | null;
  warehouse_name: string | null;
  product_id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_cost: number;
  cost_basis: "avco" | "product_cost" | "none";
  value: number;
}

export interface DriftExplanationComponent {
  code: string;
  label: string;
  count: number | null;
  amount: number;
  quantity?: number;
}

export interface DriftExplanation {
  as_of: string;
  drift: number;
  components: DriftExplanationComponent[];
  unexplained: number;
}

export interface BackfillResult {
  success?: boolean;
  skipped?: boolean;
  dry_run?: boolean;
  reason?: string;
  journal_entry_id?: string;
  business_id?: string;
  entry_date?: string;
  total_posted?: number;
  total?: number;
  debit_account_id?: string;
  credit_account_id?: string;
}

function useScope() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return { orgId: currentOrg?.id, businessId: currentBusiness?.id ?? null };
}

export function useInventoryReconciliation(asOf?: string) {
  const { orgId, businessId } = useScope();

  return useQuery({
    queryKey: ["inventory-gl-reconciliation", orgId, businessId, asOf ?? "today"],
    queryFn: async (): Promise<InventoryReconciliationRow[]> => {
      if (!orgId) return [];
      const { data, error } = await (supabase as any).rpc(
        "reconcile_inventory_subledger_to_gl",
        { p_org: orgId, p_business: businessId, p_as_of: asOf ?? null },
      );
      if (error) throw error;
      return (data ?? []) as InventoryReconciliationRow[];
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}

export function useNegativeStockPositions(enabled = true) {
  const { orgId, businessId } = useScope();

  return useQuery({
    queryKey: ["inventory-negative-stock", orgId, businessId],
    queryFn: async (): Promise<NegativeStockPosition[]> => {
      if (!orgId) return [];
      const { data, error } = await (supabase as any).rpc(
        "list_negative_stock_positions",
        { p_org: orgId, p_business: businessId },
      );
      if (error) throw error;
      return (data ?? []) as NegativeStockPosition[];
    },
    enabled: !!orgId && enabled,
    staleTime: 30_000,
  });
}

export function useInventorySubledgerComposition(enabled = true) {
  const { orgId, businessId } = useScope();

  return useQuery({
    queryKey: ["inventory-subledger-composition", orgId, businessId],
    queryFn: async (): Promise<SubledgerCompositionRow[]> => {
      if (!orgId) return [];
      const { data, error } = await (supabase as any).rpc(
        "list_inventory_subledger_composition",
        { p_org: orgId, p_business: businessId, p_limit: 500 },
      );
      if (error) throw error;
      return (data ?? []) as SubledgerCompositionRow[];
    },
    enabled: !!orgId && enabled,
    staleTime: 30_000,
  });
}

export function useInventoryDriftExplanation(asOf?: string, enabled = true) {
  const { orgId, businessId } = useScope();

  return useQuery({
    queryKey: ["inventory-gl-drift-explanation", orgId, businessId, asOf ?? "today"],
    queryFn: async (): Promise<DriftExplanation | null> => {
      if (!orgId) return null;
      const { data, error } = await (supabase as any).rpc(
        "explain_inventory_gl_drift",
        { p_org: orgId, p_business: businessId, p_as_of: asOf ?? null },
      );
      if (error) throw error;
      return (data ?? null) as DriftExplanation | null;
    },
    enabled: !!orgId && enabled,
    staleTime: 30_000,
  });
}

/**
 * Opening-inventory remediation. ALWAYS call with `dryRun: true` first and
 * show the preview; posting is a second, explicit call.
 */
export function useBackfillOpeningInventory() {
  const { orgId, businessId } = useScope();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (vars: { asOf?: string; dryRun: boolean }): Promise<BackfillResult> => {
      if (!orgId) throw new Error("No organization");
      const { data, error } = await (supabase as any).rpc(
        "backfill_opening_inventory_gl",
        {
          p_org: orgId,
          p_business: businessId,
          p_as_of: vars.asOf ?? null,
          p_dry_run: vars.dryRun,
        },
      );
      if (error) throw error;
      return (data ?? {}) as BackfillResult;
    },
    onSuccess: (result) => {
      if (result.dry_run) return; // preview only — the dialog renders it
      if (result.skipped) {
        toast.info(`Nothing posted: ${result.reason}`);
      } else {
        toast.success(
          `Opening inventory journal posted (${(result.total_posted ?? 0).toLocaleString()})`,
        );
      }
      qc.invalidateQueries({ queryKey: ["inventory-gl-reconciliation"] });
      qc.invalidateQueries({ queryKey: ["inventory-gl-drift-explanation"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["financial-report"] });
      qc.invalidateQueries({ queryKey: ["accounting-integrity-findings"] });
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });
}
