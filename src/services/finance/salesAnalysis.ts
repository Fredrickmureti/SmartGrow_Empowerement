/**
 * Sales analysis — client seam.
 *
 * Sales measures (gross, discounts, net sales, tax, returns, cost, margin) are
 * accounting output. They are produced by `finance_sales_analysis` in SQL from
 * ledger-posted, non-void invoices and their credit notes, in BASE currency,
 * and consumed verbatim here. This module is the ONLY caller of the sales
 * analysis RPCs.
 *
 * Never reintroduce the previous approach (load `invoices` into the browser
 * with `useInvoices()` and fold `inv.total` with `reduce`): it ignored credit
 * notes, returns, discounts and cost, mixed document currencies, counted
 * unposted documents, and silently truncated at the client row limit.
 *
 * Taxonomy: one engine, one `_dimension` parameter. Customer, product,
 * category, branch, salesperson and month are grouping keys over the same
 * source rows and the same measure set — not separate report families.
 */

import { supabase } from "@/integrations/supabase/client";

export const SALES_DIMENSIONS = [
  "customer",
  "product",
  "category",
  "branch",
  "salesperson",
  "month",
] as const;

export type SalesDimension = (typeof SALES_DIMENSIONS)[number];

export const SALES_DIMENSION_LABELS: Record<SalesDimension, string> = {
  customer: "Customer",
  product: "Product",
  category: "Category",
  branch: "Branch",
  salesperson: "Salesperson",
  month: "Month",
};

export const isSalesDimension = (value: unknown): value is SalesDimension =>
  typeof value === "string" && (SALES_DIMENSIONS as readonly string[]).includes(value);

export interface SalesAnalysisRow {
  /** Raw grouping key: a UUID, a `YYYY-MM` month, or `unassigned`. */
  dimension_key: string;
  /** Resolved UUID when the dimension is an entity, else null. */
  dimension_id: string | null;
  label: string;
  gross: number;
  discount: number;
  net_sales: number;
  tax: number;
  returns: number;
  net_after_returns: number;
  cost: number;
  margin: number;
  margin_pct: number | null;
  quantity: number;
  sale_documents: number;
  return_documents: number;
}

export interface SalesAnalysisTotals {
  gross: number;
  discount: number;
  net_sales: number;
  tax: number;
  returns: number;
  net_after_returns: number;
  cost: number;
  margin: number;
  quantity: number;
  sale_documents: number;
  return_documents: number;
}

export interface SalesAnalysisResult {
  dimension: SalesDimension;
  from: string;
  to: string;
  rows: SalesAnalysisRow[];
  totals: SalesAnalysisTotals;
  paging: { total_rows: number; limit: number | null; offset: number };
}

export interface SalesAnalysisParams {
  orgId: string;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
  dimension: SalesDimension;
  limit?: number | null;
  offset?: number;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;

export const EMPTY_SALES_TOTALS: SalesAnalysisTotals = {
  gross: 0,
  discount: 0,
  net_sales: 0,
  tax: 0,
  returns: 0,
  net_after_returns: 0,
  cost: 0,
  margin: 0,
  quantity: 0,
  sale_documents: 0,
  return_documents: 0,
};

function normalizeRow(raw: Record<string, unknown>): SalesAnalysisRow {
  return {
    dimension_key: String(raw.dimension_key ?? ""),
    dimension_id: (raw.dimension_id as string | null) ?? null,
    label: String(raw.label ?? "Unassigned"),
    gross: num(raw.gross),
    discount: num(raw.discount),
    net_sales: num(raw.net_sales),
    tax: num(raw.tax),
    returns: num(raw.returns),
    net_after_returns: num(raw.net_after_returns),
    cost: num(raw.cost),
    margin: num(raw.margin),
    margin_pct: raw.margin_pct === null || raw.margin_pct === undefined ? null : num(raw.margin_pct),
    quantity: num(raw.quantity),
    sale_documents: Number(raw.sale_documents ?? 0) || 0,
    return_documents: Number(raw.return_documents ?? 0) || 0,
  };
}

/**
 * One page of the sales analysis for a single dimension.
 * Pass `limit: null` for the export path — never re-aggregate the visible page.
 */
export async function fetchSalesAnalysis(
  params: SalesAnalysisParams,
): Promise<SalesAnalysisResult> {
  const { data, error } = await (supabase.rpc as any)("finance_sales_analysis", {
    _org_id: params.orgId,
    _from: params.from,
    _to: params.to,
    _business_id: params.businessId ?? null,
    _branch_id: params.branchId ?? null,
    _dimension: params.dimension,
    _limit: params.limit ?? null,
    _offset: params.offset ?? 0,
  });

  if (error) throw error;

  const payload = (data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : [];
  const totals = (payload.totals ?? {}) as Record<string, unknown>;
  const paging = (payload.paging ?? {}) as Record<string, unknown>;

  return {
    dimension: isSalesDimension(payload.dimension) ? payload.dimension : params.dimension,
    from: String(payload.from ?? params.from),
    to: String(payload.to ?? params.to),
    rows: rows.map(normalizeRow),
    totals: {
      gross: num(totals.gross),
      discount: num(totals.discount),
      net_sales: num(totals.net_sales),
      tax: num(totals.tax),
      returns: num(totals.returns),
      net_after_returns: num(totals.net_after_returns),
      cost: num(totals.cost),
      margin: num(totals.margin),
      quantity: num(totals.quantity),
      sale_documents: Number(totals.sale_documents ?? 0) || 0,
      return_documents: Number(totals.return_documents ?? 0) || 0,
    },
    paging: {
      total_rows: Number(paging.total_rows ?? 0) || 0,
      limit: (paging.limit as number | null) ?? null,
      offset: Number(paging.offset ?? 0) || 0,
    },
  };
}

export interface SalesRevenueReconciliation {
  from: string;
  to: string;
  documentNetSales: number;
  glRevenue: number;
  glSalesReturns: number;
  glDiscountsGiven: number;
  ledgerNetSales: number;
  variance: number;
  inBalance: boolean;
}

/**
 * Tie document net sales to GL revenue less sales returns and discounts.
 * A non-zero variance is a bookkeeping finding — surface it, never tune the
 * report to make it disappear.
 */
export async function fetchSalesRevenueReconciliation(params: {
  orgId: string;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
}): Promise<SalesRevenueReconciliation | null> {
  const { data, error } = await (supabase.rpc as any)(
    "finance_sales_revenue_reconciliation",
    {
      _org_id: params.orgId,
      _from: params.from,
      _to: params.to,
      _business_id: params.businessId ?? null,
      _branch_id: params.branchId ?? null,
    },
  );

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return null;

  return {
    from: String(row.from ?? params.from),
    to: String(row.to ?? params.to),
    documentNetSales: num(row.document_net_sales),
    glRevenue: num(row.gl_revenue),
    glSalesReturns: num(row.gl_sales_returns),
    glDiscountsGiven: num(row.gl_discounts_given),
    ledgerNetSales: num(row.ledger_net_sales),
    variance: num(row.variance),
    inBalance: Boolean(row.in_balance),
  };
}
