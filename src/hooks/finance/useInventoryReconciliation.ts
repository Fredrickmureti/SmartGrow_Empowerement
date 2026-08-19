import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

/**
 * Inventory subledger ⇄ General Ledger control-account reconciliation.
 *
 * Contract (Phase 6 — supersedes the AVCO basis documented in ADR 0017):
 *  - Valuation basis is the COST-LAYER ledger, reconstructed as at the
 *    reporting date by `public._inventory_layer_valuation_as_of()` — the same
 *    helper `report_inventory_valuation_as_of()` reads. The reconciliation and
 *    the Inventory Valuation report therefore cannot disagree.
 *  - Positions with no cost layer, zero-cost layers, or negative quantity are
 *    COUNTED and surfaced, never silently absorbed into the total.
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
  /** Positions with quantity on the operational snapshot but no cost layer. */
  unlayered_positions: number;
  zero_cost_positions: number;
  negative_qty_positions: number;
}

/**
 * Negative stock is an OPERATIONAL defect: negative quantity has no cost
 * layers behind it, so the amount shown is an explicitly named AVCO /
 * product-cost exposure estimate — never an accounting valuation.
 */
export interface NegativeStockPosition {
  product_id: string;
  product_name: string;
  sku: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  quantity: number;
  avco_unit_cost: number;
  avco_exposure_estimate: number;
}

/**
 * Line-by-line composition of `subledger_value`, built from the same
 * `_inventory_layer_valuation_as_of()` data as the reconciliation total, so
 * the `value` column sums to that total. `unlayered` rows carry quantity with
 * no cost layer and are therefore listed at zero value, flagged rather than
 * estimated.
 */
export type SubledgerCostBasis =
  | "cost_layer"
  | "zero_cost_layer"
  | "negative_layer"
  | "unlayered";

export interface SubledgerCompositionRow {
  warehouse_id: string | null;
  warehouse_name: string | null;
  product_id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_cost: number;
  cost_basis: SubledgerCostBasis;
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
  /** Basis of the posted amount. Product cost only — these positions have no layers. */
  basis?: "product_cost_estimate";
  /** Drift measured on the authoritative layer basis; the posting is capped at it. */
  layer_basis_drift?: number;
  estimated_total?: number;
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
      // p_business is an authorization boundary server-side: the RPC rejects a
      // null business for signed-in callers, so never fire without one.
      if (!orgId || !businessId) return [];
      const { data, error } = await (supabase as any).rpc(
        "reconcile_inventory_subledger_to_gl",
        { p_org: orgId, p_business: businessId, p_as_of: asOf ?? null },
      );
      if (error) throw error;
      return (data ?? []) as InventoryReconciliationRow[];
    },
    enabled: !!orgId && !!businessId,
    staleTime: 30_000,
  });
}


export function useNegativeStockPositions(enabled = true) {
  const { orgId, businessId } = useScope();

  return useQuery({
    queryKey: ["inventory-negative-stock", orgId, businessId],
    queryFn: async (): Promise<NegativeStockPosition[]> => {
      // p_business is an authorization boundary server-side (Phase 6b).
      if (!orgId || !businessId) return [];
      const { data, error } = await (supabase as any).rpc(
        "list_negative_stock_positions",
        { p_org: orgId, p_business: businessId },
      );
      if (error) throw error;
      return (data ?? []) as NegativeStockPosition[];
    },
    enabled: !!orgId && !!businessId && enabled,
    staleTime: 30_000,
  });
}

/**
 * Composition of the subledger figure at the SAME as-at date the
 * reconciliation used — otherwise the drill-down would explain a different
 * number than the one on screen.
 */
export function useInventorySubledgerComposition(enabled = true, asOf?: string) {
  const { orgId, businessId } = useScope();

  return useQuery({
    queryKey: ["inventory-subledger-composition", orgId, businessId, asOf ?? "today"],
    queryFn: async (): Promise<SubledgerCompositionRow[]> => {
      if (!orgId || !businessId) return [];
      const { data, error } = await (supabase as any).rpc(
        "list_inventory_subledger_composition",
        { p_org: orgId, p_business: businessId, p_as_of: asOf ?? null, p_limit: 500 },
      );
      if (error) throw error;
      return (data ?? []) as SubledgerCompositionRow[];
    },
    enabled: !!orgId && !!businessId && enabled,
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
