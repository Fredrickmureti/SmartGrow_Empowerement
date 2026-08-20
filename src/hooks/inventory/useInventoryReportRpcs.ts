/**
 * Client access to the two canonical inventory reporting RPCs.
 *
 *   report_inventory_valuation_as_of  → value ledger, as at a date
 *   report_stock_ledger               → quantity ledger, opening → in/out → closing
 *
 * Both are SECURITY DEFINER and enforce business (and, when supplied, branch)
 * authorization server-side; `p_business` is an authorization boundary, not a
 * filter, so the hooks never fire without one. Both return `total_rows`, so we
 * page explicitly instead of silently truncating at PostgREST's 1,000-row cap.
 *
 * These hooks are the ONLY browser path to inventory valuation / ledger
 * figures. No component may re-derive value from live on-hand × current AVCO.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const PAGE_SIZE = 5000;
const MAX_ROWS = 100_000;

export interface ValuationRow {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  category_id: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  branch_id: string | null;
  layer_count: number;
  qty_on_hand: number;
  avg_unit_cost: number;
  total_value: number;
  oldest_receipt_at: string | null;
  total_rows: number;
}

export interface StockLedgerRow {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  category_id: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  branch_id: string | null;
  opening_qty: number;
  qty_in: number;
  qty_out: number;
  closing_qty: number;
  movement_count: number;
  total_rows: number;
}

async function fetchAllPages<T extends { total_rows: number }>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await (supabase as any).rpc(fn, {
      ...args,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (error) throw error;

    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length === 0) break;

    const total = Number(rows[0].total_rows ?? out.length);
    offset += rows.length;
    if (out.length >= total || out.length >= MAX_ROWS || rows.length < PAGE_SIZE) break;
  }

  return out;
}

export interface InventoryDimensionFilters {
  branchId?: string | null;
  warehouseId?: string | null;
  productId?: string | null;
  categoryId?: string | null;
}

export function useInventoryValuationAsOf(params: {
  orgId?: string | null;
  businessId?: string | null;
  asOf: string;
  filters?: InventoryDimensionFilters;
  enabled?: boolean;
}) {
  const { orgId, businessId, asOf, filters = {}, enabled = true } = params;

  return useQuery({
    queryKey: ["inventory-valuation-as-of", orgId, businessId, asOf, filters],
    queryFn: async () =>
      fetchAllPages<ValuationRow>("report_inventory_valuation_as_of", {
        p_org: orgId,
        p_business: businessId,
        p_as_of: asOf,
        p_branch: filters.branchId ?? null,
        p_warehouse: filters.warehouseId ?? null,
        p_product: filters.productId ?? null,
        p_category: filters.categoryId ?? null,
      }),
    enabled: enabled && !!orgId && !!businessId && !!asOf,
    staleTime: 30_000,
  });
}

export interface AgingRow {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  category_id: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  branch_id: string | null;
  qty_0_30: number;
  value_0_30: number;
  qty_31_60: number;
  value_31_60: number;
  qty_61_90: number;
  value_61_90: number;
  qty_90_plus: number;
  value_90_plus: number;
  qty_on_hand: number;
  total_value: number;
  oldest_receipt_at: string | null;
  layer_count: number;
  total_rows: number;
}

/**
 * Stock aging on COST LAYERS as at a date. Each remaining layer is bucketed by
 * its own receipt date, so bucket values sum to the Inventory Valuation total
 * value for the same date. Never age the product by its last inbound movement.
 */
export function useInventoryAgingAsOf(params: {
  orgId?: string | null;
  businessId?: string | null;
  asOf: string;
  filters?: InventoryDimensionFilters;
  enabled?: boolean;
}) {
  const { orgId, businessId, asOf, filters = {}, enabled = true } = params;

  return useQuery({
    queryKey: ["inventory-aging-as-of", orgId, businessId, asOf, filters],
    queryFn: async () =>
      fetchAllPages<AgingRow>("report_inventory_aging_as_of", {
        p_org: orgId,
        p_business: businessId,
        p_as_of: asOf,
        p_branch: filters.branchId ?? null,
        p_warehouse: filters.warehouseId ?? null,
        p_product: filters.productId ?? null,
        p_category: filters.categoryId ?? null,
      }),
    enabled: enabled && !!orgId && !!businessId && !!asOf,
    staleTime: 30_000,
  });
}

export function useStockLedger(params: {
  orgId?: string | null;
  businessId?: string | null;
  dateFrom: string;
  dateTo: string;
  filters?: InventoryDimensionFilters;
  enabled?: boolean;
}) {
  const { orgId, businessId, dateFrom, dateTo, filters = {}, enabled = true } = params;

  return useQuery({
    queryKey: ["inventory-stock-ledger", orgId, businessId, dateFrom, dateTo, filters],
    queryFn: async () =>
      fetchAllPages<StockLedgerRow>("report_stock_ledger", {
        p_org: orgId,
        p_business: businessId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_branch: filters.branchId ?? null,
        p_warehouse: filters.warehouseId ?? null,
        p_product: filters.productId ?? null,
        p_category: filters.categoryId ?? null,
      }),
    enabled: enabled && !!orgId && !!businessId && !!dateFrom && !!dateTo,
    staleTime: 30_000,
  });
}

export interface LotTraceabilityRow {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  category_id: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  branch_id: string | null;
  lot_number: string | null;
  lot_id: string | null;
  supplier_name: string | null;
  receipt_number: string | null;
  manufacture_date: string | null;
  expiry_date: string | null;
  days_to_expiry: number | null;
  expiry_bucket: string | null;
  lot_status: string | null;
  layer_count: number;
  qty_received: number;
  qty_consumed: number;
  qty_on_hand: number;
  avg_unit_cost: number;
  total_value: number;
  first_receipt_at: string | null;
  last_movement_at: string | null;
  total_rows: number;
}

export interface LotTraceabilityFilters extends InventoryDimensionFilters {
  lotNumber?: string | null;
  lotStatus?: string | null;
  expiryBucket?: string | null;
  includeDepleted?: boolean;
}

/**
 * Lot / serial traceability AS AT a date. Value is produced by the SAME shared
 * layer valuation helper the Inventory Valuation report uses (lot grain), so
 * the value column ties to valuation at the same date. Depleted lots are hidden
 * server-side unless `includeDepleted` is set, for the same reason.
 */
export function useLotTraceabilityAsOf(params: {
  orgId?: string | null;
  businessId?: string | null;
  asOf: string;
  filters?: LotTraceabilityFilters;
  enabled?: boolean;
}) {
  const { orgId, businessId, asOf, filters = {}, enabled = true } = params;

  return useQuery({
    queryKey: ["inventory-lot-traceability-as-of", orgId, businessId, asOf, filters],
    queryFn: async () =>
      fetchAllPages<LotTraceabilityRow>("report_lot_traceability_as_of", {
        p_org: orgId,
        p_business: businessId,
        p_as_of: asOf,
        p_branch: filters.branchId ?? null,
        p_warehouse: filters.warehouseId ?? null,
        p_product: filters.productId ?? null,
        p_category: filters.categoryId ?? null,
        p_lot: filters.lotNumber?.trim() ? filters.lotNumber.trim() : null,
        p_status: filters.lotStatus ?? null,
        p_expiry_bucket: filters.expiryBucket ?? null,
        p_include_depleted: filters.includeDepleted ?? false,
      }),
    enabled: enabled && !!orgId && !!businessId && !!asOf,
    staleTime: 30_000,
  });
}

/* ---------------------------------------------------------------------------
 * Phase 8 — operational stock reports (adjustments / transfers).
 *
 * These used to be browser-side aggregations over `stock_adjustments` +
 * `stock_adjustment_items` / `stock_transfers` + `stock_transfer_items`:
 * the page summed quantity × unit_cost itself, never paged past PostgREST's
 * 1,000-row cap, and treated the company as an optional filter. Both are now
 * server RPCs with the same authorization + paging contract as valuation and
 * the stock ledger.
 * ------------------------------------------------------------------------ */

/**
 * Which fact the `cost_impact` figure came from. `movement_ledger` is the
 * posted, auditable number; `estimated_from_lines` means nothing has posted
 * yet and the figure is intent, not accounting. The UI must show the
 * difference — an unposted estimate may never read as a posted amount.
 */
export type AdjustmentCostBasis = "movement_ledger" | "estimated_from_lines" | "none";

export interface StockAdjustmentReportRow {
  adjustment_id: string;
  adjustment_number: string | null;
  adjustment_date: string;
  reason: string | null;
  status: string;
  warehouse_id: string | null;
  branch_id: string | null;
  approved_at: string | null;
  reverses_adjustment_id: string | null;
  line_count: number;
  abs_qty: number;
  cost_impact: number;
  cost_basis: AdjustmentCostBasis;
  total_rows: number;
}

export interface StockTransferReportRow {
  transfer_id: string;
  transfer_number: string | null;
  transfer_date: string;
  status: string;
  from_branch_id: string | null;
  to_branch_id: string | null;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  from_warehouse_name: string | null;
  to_warehouse_name: string | null;
  expected_arrival_date: string | null;
  actual_arrival_date: string | null;
  completed_at: string | null;
  line_count: number;
  qty_requested: number;
  qty_sent: number;
  qty_received: number;
  variance: number;
  total_rows: number;
}

export interface StockOperationsFilters {
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  status?: string | null;
  reason?: string | null;
}

export function useStockAdjustmentsReport(params: {
  orgId?: string | null;
  businessId?: string | null;
  filters?: StockOperationsFilters;
  enabled?: boolean;
}) {
  const { orgId, businessId, filters = {}, enabled = true } = params;

  return useQuery({
    queryKey: ["stock-adjustments-report", orgId, businessId, filters],
    queryFn: async () =>
      fetchAllPages<StockAdjustmentReportRow>("report_stock_adjustments", {
        p_org: orgId,
        p_business: businessId,
        p_branch: filters.branchId ?? null,
        p_from: filters.from || null,
        p_to: filters.to || null,
        p_status: filters.status ?? null,
        p_reason: filters.reason ?? null,
      }),
    // `p_business` is an authorization boundary, not a filter: without an
    // active company the report must not run at all.
    enabled: enabled && !!orgId && !!businessId,
    staleTime: 30_000,
  });
}

export function useStockTransfersReport(params: {
  orgId?: string | null;
  businessId?: string | null;
  filters?: StockOperationsFilters;
  enabled?: boolean;
}) {
  const { orgId, businessId, filters = {}, enabled = true } = params;

  return useQuery({
    queryKey: ["stock-transfers-report", orgId, businessId, filters],
    queryFn: async () =>
      fetchAllPages<StockTransferReportRow>("report_stock_transfers", {
        p_org: orgId,
        p_business: businessId,
        p_branch: filters.branchId ?? null,
        p_from: filters.from || null,
        p_to: filters.to || null,
        p_status: filters.status ?? null,
      }),
    enabled: enabled && !!orgId && !!businessId,
    staleTime: 30_000,
  });
}
