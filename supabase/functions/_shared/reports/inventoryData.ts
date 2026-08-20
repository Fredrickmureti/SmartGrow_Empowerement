/**
 * inventoryData — server-build helpers for the inventory report keys.
 *
 * Mirrors attendanceData / payrollData / projectsData, so the live report
 * page, the export path (PDF/CSV/XLSX) and `process-scheduled-reports` all
 * produce the SAME rows from the SAME source.
 *
 * Both keys read the Phase 2 reporting RPCs rather than base tables:
 *
 *   stock_ledger        → public.report_stock_ledger()
 *                         quantity ledger: opening → in → out → closing,
 *                         per product × warehouse × branch, posting-date
 *                         semantics on stock_movements.movement_date.
 *
 *   inventory_valuation → public.report_inventory_valuation_as_of()
 *                         value ledger: quantity on hand and value AS AT a
 *                         date, reconstructed from cost_layers receipts less
 *                         cost_layer_consumptions up to that date.
 *
 * Why RPCs and not queries here: business/branch authorization, movement
 * direction and as-of layer arithmetic are accounting rules. They belong in
 * one place (the database), not duplicated per caller. The RPCs also return
 * `total_rows`, so this module pages explicitly instead of silently
 * truncating at PostgREST's 1,000-row cap.
 *
 * Each row carries `_meta = { sourceDocType: "product", sourceDocId }` so the
 * existing drill-down router can deep-link a row back to the product.
 */
// deno-lint-ignore-file no-explicit-any
import type { ReportResult } from "../reportDataEngine.ts";

export type InventoryReportKey =
  | "stock_ledger"
  | "inventory_valuation"
  | "inventory_aging"
  | "inventory_gl_reconciliation"
  | "lot_traceability";

export interface InventoryFilters {
  branchId?: string | null;
  warehouseId?: string | null;
  productId?: string | null;
  categoryId?: string | null;
  /** Valuation only. Defaults to `dateTo` when omitted. */
  asOf?: string | null;
  /** Lot traceability only. */
  lotNumber?: string | null;
  lotStatus?: string | null;
  expiryBucket?: string | null;
  includeDepleted?: boolean | null;
}

/** Hard ceiling per report run — matches the RPC's own page cap. */
const PAGE_SIZE = 5000;
const MAX_ROWS = 100_000;

const num = (v: unknown) => Number(v ?? 0);

const withMeta = (row: Record<string, unknown>, productId: string | null) => ({
  ...row,
  _meta: { sourceDocType: "product", sourceDocId: productId },
});

/**
 * Page through a reporting RPC until every row is fetched. `total_rows` is a
 * window count returned on each row, so a short page is not proof of the end.
 */
async function fetchAllPages(
  supabase: any,
  fn: string,
  args: Record<string, unknown>,
): Promise<any[]> {
  const out: any[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.rpc(fn, {
      ...args,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (error) throw new Error(`${fn} failed: ${error.message}`);

    const rows = (data ?? []) as any[];
    out.push(...rows);
    if (rows.length === 0) break;

    const total = num(rows[0].total_rows);
    offset += rows.length;
    if (out.length >= total || out.length >= MAX_ROWS || rows.length < PAGE_SIZE) break;
  }

  return out;
}

export async function buildInventoryReport(
  supabase: any,
  reportType: InventoryReportKey,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: InventoryFilters,
): Promise<ReportResult> {
  // Business is an authorization boundary in the RPCs, not an optional
  // filter: there is no "all businesses" inventory valuation.
  if (!businessId) {
    throw new Error("businessId is required for inventory reports");
  }

  const dimensions = {
    p_branch: filters.branchId ?? null,
    p_warehouse: filters.warehouseId ?? null,
    p_product: filters.productId ?? null,
    p_category: filters.categoryId ?? null,
  };

  if (reportType === "lot_traceability") {
    return await buildLotTraceabilityReport(supabase, orgId, businessId, dateTo, filters);
  }

  if (reportType === "stock_ledger") {
    const rows = await fetchAllPages(supabase, "report_stock_ledger", {
      p_org: orgId,
      p_business: businessId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      ...dimensions,
    });

    let opening = 0;
    let qtyIn = 0;
    let qtyOut = 0;
    let closing = 0;

    const data = rows.map((r) => {
      opening += num(r.opening_qty);
      qtyIn += num(r.qty_in);
      qtyOut += num(r.qty_out);
      closing += num(r.closing_qty);
      return withMeta(
        {
          product_name: r.product_name ?? "",
          sku: r.sku ?? "",
          warehouse_name: r.warehouse_name ?? "—",
          opening_qty: num(r.opening_qty),
          qty_in: num(r.qty_in),
          qty_out: num(r.qty_out),
          closing_qty: num(r.closing_qty),
          movement_count: num(r.movement_count),
        },
        r.product_id ?? null,
      );
    });

    return {
      data,
      summary: {
        lines: data.length,
        opening_qty: opening,
        qty_in: qtyIn,
        qty_out: qtyOut,
        closing_qty: closing,
      },
    };
  }

  if (reportType === "inventory_aging") {
    // Ages the COST LAYER, not the product: each remaining layer is bucketed
    // by its own receipt date, so bucket values sum to the same total value
    // Inventory Valuation reports at the same date.
    const agingAsOf = filters.asOf ?? dateTo;
    const agingRows = await fetchAllPages(supabase, "report_inventory_aging_as_of", {
      p_org: orgId,
      p_business: businessId,
      p_as_of: agingAsOf,
      ...dimensions,
    });

    const t = {
      qty_0_30: 0, value_0_30: 0,
      qty_31_60: 0, value_31_60: 0,
      qty_61_90: 0, value_61_90: 0,
      qty_90_plus: 0, value_90_plus: 0,
      qty_on_hand: 0, total_value: 0,
    };

    const agingData = agingRows.map((r) => {
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += num(r[k]);
      return withMeta(
        {
          product_name: r.product_name ?? "",
          sku: r.sku ?? "",
          warehouse_name: r.warehouse_name ?? "—",
          qty_0_30: num(r.qty_0_30),
          value_0_30: num(r.value_0_30),
          qty_31_60: num(r.qty_31_60),
          value_31_60: num(r.value_31_60),
          qty_61_90: num(r.qty_61_90),
          value_61_90: num(r.value_61_90),
          qty_90_plus: num(r.qty_90_plus),
          value_90_plus: num(r.value_90_plus),
          qty_on_hand: num(r.qty_on_hand),
          total_value: num(r.total_value),
          oldest_receipt_at: r.oldest_receipt_at
            ? String(r.oldest_receipt_at).slice(0, 10)
            : "",
        },
        r.product_id ?? null,
      );
    });

    return {
      data: agingData,
      summary: { lines: agingData.length, as_of: agingAsOf, ...t },
    };
  }

  if (reportType === "inventory_gl_reconciliation") {
    // Entity-level control report: one row per configured inventory control
    // account. The subledger side is the same as-at layer valuation the
    // inventory_valuation key reports, so drift is attributable to the GL.
    const reconAsOf = filters.asOf ?? dateTo;
    const { data, error } = await supabase.rpc("reconcile_inventory_subledger_to_gl", {
      p_org: orgId,
      p_business: businessId,
      p_as_of: reconAsOf,
    });
    if (error) {
      throw new Error(`reconcile_inventory_subledger_to_gl failed: ${error.message}`);
    }

    let subledger = 0;
    let gl = 0;
    let drift = 0;

    const reconData = ((data ?? []) as any[]).map((r) => {
      subledger += num(r.subledger_value);
      gl += num(r.gl_closing);
      drift += num(r.drift);
      const exceptions = [
        num(r.unlayered_positions) ? `${num(r.unlayered_positions)} no cost layer` : null,
        num(r.zero_cost_positions) ? `${num(r.zero_cost_positions)} zero cost` : null,
        num(r.negative_qty_positions) ? `${num(r.negative_qty_positions)} negative qty` : null,
      ].filter(Boolean).join(", ");
      return {
        account_code: r.account_code ?? "",
        account_name: r.account_name ?? "",
        subledger_value: num(r.subledger_value),
        gl_closing: num(r.gl_closing),
        drift: num(r.drift),
        exceptions: exceptions || "none",
      };
    });

    return {
      data: reconData,
      summary: {
        lines: reconData.length,
        as_of: reconAsOf,
        subledger_value: subledger,
        gl_closing: gl,
        drift,
      },
    };
  }

  // inventory_valuation — value ledger, as at a date.
  const asOf = filters.asOf ?? dateTo;
  const rows = await fetchAllPages(supabase, "report_inventory_valuation_as_of", {
    p_org: orgId,
    p_business: businessId,
    p_as_of: asOf,
    ...dimensions,
  });

  let totalQty = 0;
  let totalValue = 0;

  const data = rows.map((r) => {
    totalQty += num(r.qty_on_hand);
    totalValue += num(r.total_value);
    return withMeta(
      {
        product_name: r.product_name ?? "",
        sku: r.sku ?? "",
        warehouse_name: r.warehouse_name ?? "—",
        qty_on_hand: num(r.qty_on_hand),
        avg_unit_cost: num(r.avg_unit_cost),
        total_value: num(r.total_value),
        oldest_receipt_at: r.oldest_receipt_at
          ? String(r.oldest_receipt_at).slice(0, 10)
          : "",
        layer_count: num(r.layer_count),
      },
      r.product_id ?? null,
    );
  });

  return {
    data,
    summary: {
      lines: data.length,
      as_of: asOf,
      qty_on_hand: totalQty,
      total_value: totalValue,
    },
  };
}

/**
 * lot_traceability — Phase 7.
 *
 * One row per product × warehouse × lot AS AT a date, valued on the SAME
 * cost-layer basis as `inventory_valuation` (both read the shared SQL helper
 * `_inventory_layer_valuation_as_of`, the lot report simply asks for the lot
 * grain). With `includeDepleted = false` the value column therefore sums to
 * the Inventory Valuation total for the same date; opting depleted lots back
 * in is a traceability view, not a valuation view.
 */
export async function buildLotTraceabilityReport(
  supabase: any,
  orgId: string,
  businessId: string,
  dateTo: string,
  filters: InventoryFilters,
): Promise<ReportResult> {
  const asOf = filters.asOf ?? dateTo;

  const rows = await fetchAllPages(supabase, "report_lot_traceability_as_of", {
    p_org: orgId,
    p_business: businessId,
    p_as_of: asOf,
    p_branch: filters.branchId ?? null,
    p_warehouse: filters.warehouseId ?? null,
    p_product: filters.productId ?? null,
    p_category: filters.categoryId ?? null,
    p_lot: filters.lotNumber ?? null,
    p_status: filters.lotStatus ?? null,
    p_expiry_bucket: filters.expiryBucket ?? null,
    p_include_depleted: filters.includeDepleted ?? false,
  });

  let qtyOnHand = 0;
  let totalValue = 0;
  let expiring = 0;
  let blocked = 0;

  const data = rows.map((r) => {
    qtyOnHand += num(r.qty_on_hand);
    totalValue += num(r.total_value);
    if (r.expiry_bucket === "expired" || r.expiry_bucket === "0_30") {
      expiring += num(r.total_value);
    }
    if (r.lot_status === "quarantined" || r.lot_status === "recalled") {
      blocked += num(r.total_value);
    }
    return withMeta(
      {
        product_name: r.product_name ?? "",
        sku: r.sku ?? "",
        warehouse_name: r.warehouse_name ?? "—",
        lot_number: r.lot_number ?? "—",
        expiry_date: r.expiry_date ? String(r.expiry_date).slice(0, 10) : "",
        days_to_expiry: r.days_to_expiry === null || r.days_to_expiry === undefined
          ? ""
          : num(r.days_to_expiry),
        lot_status: r.lot_status ?? "",
        qty_received: num(r.qty_received),
        qty_consumed: num(r.qty_consumed),
        qty_on_hand: num(r.qty_on_hand),
        avg_unit_cost: num(r.avg_unit_cost),
        total_value: num(r.total_value),
        supplier_name: r.supplier_name ?? "",
        receipt_number: r.receipt_number ?? "",
      },
      r.product_id ?? null,
    );
  });

  return {
    data,
    summary: {
      lines: data.length,
      as_of: asOf,
      qty_on_hand: qtyOnHand,
      total_value: totalValue,
      expiring_value: expiring,
      blocked_value: blocked,
    },
  };
}
