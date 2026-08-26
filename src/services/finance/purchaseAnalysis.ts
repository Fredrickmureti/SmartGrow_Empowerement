/**
 * Purchase analysis — client seam.
 *
 * Purchases measures (gross, discounts, net purchases, tax, returns) are
 * accounting output. They are produced by `finance_purchase_analysis` in SQL
 * from ledger-posted, non-void supplier bills and vendor credit notes, in BASE
 * currency, and consumed verbatim here. This module is the ONLY caller of the
 * purchase analysis RPCs.
 *
 * Never fold `bills` in the browser: that ignores vendor credit notes, header
 * discounts and document currency, counts unposted bills, and truncates at the
 * client row limit.
 *
 * Taxonomy: one engine, one `_dimension` parameter. Supplier, product,
 * category, expense account, branch and month are grouping keys over the same
 * source rows and the same measure set — not separate report families.
 */

import { supabase } from "@/integrations/supabase/client";

export const PURCHASE_DIMENSIONS = [
  "supplier",
  "product",
  "category",
  "account",
  "branch",
  "month",
] as const;

export type PurchaseDimension = (typeof PURCHASE_DIMENSIONS)[number];

export const PURCHASE_DIMENSION_LABELS: Record<PurchaseDimension, string> = {
  supplier: "Supplier",
  product: "Product",
  category: "Category",
  account: "Expense account",
  branch: "Branch",
  month: "Month",
};

export const isPurchaseDimension = (value: unknown): value is PurchaseDimension =>
  typeof value === "string" &&
  (PURCHASE_DIMENSIONS as readonly string[]).includes(value);

export interface PurchaseAnalysisRow {
  /** Raw grouping key: a UUID, a `YYYY-MM` month, or `unassigned`. */
  dimension_key: string;
  /** Resolved UUID when the dimension is an entity, else null. */
  dimension_id: string | null;
  label: string;
  gross: number;
  discount: number;
  net_purchases: number;
  tax: number;
  returns: number;
  net_after_returns: number;
  quantity: number;
  purchase_documents: number;
  return_documents: number;
}

export interface PurchaseAnalysisTotals {
  gross: number;
  discount: number;
  net_purchases: number;
  tax: number;
  returns: number;
  net_after_returns: number;
  quantity: number;
  purchase_documents: number;
  return_documents: number;
  /**
   * Documents in range that carry no conversion evidence (foreign currency,
   * no stamped rate). They are EXCLUDED from every measure above — their base
   * value is unknown, never assumed to be 1:1.
   */
  unconvertible_document_count: number;
}

/** Documents excluded for want of a rate, split by kind. */
export interface UnconvertibleDocuments {
  purchase_documents: number;
  return_documents: number;
  total: number;
}

export interface PurchaseAnalysisResult {
  dimension: PurchaseDimension;
  from: string;
  to: string;
  rows: PurchaseAnalysisRow[];
  totals: PurchaseAnalysisTotals;
  unconvertible: UnconvertibleDocuments;
  paging: { total_rows: number; limit: number | null; offset: number };
}

export interface PurchaseAnalysisParams {
  orgId: string;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
  dimension: PurchaseDimension;
  limit?: number | null;
  offset?: number;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;

export const EMPTY_PURCHASE_TOTALS: PurchaseAnalysisTotals = {
  gross: 0,
  discount: 0,
  net_purchases: 0,
  tax: 0,
  returns: 0,
  net_after_returns: 0,
  quantity: 0,
  purchase_documents: 0,
  return_documents: 0,
  unconvertible_document_count: 0,
};

export const EMPTY_UNCONVERTIBLE: UnconvertibleDocuments = {
  purchase_documents: 0,
  return_documents: 0,
  total: 0,
};

function normalizeRow(raw: Record<string, unknown>): PurchaseAnalysisRow {
  return {
    dimension_key: String(raw.dimension_key ?? ""),
    dimension_id: (raw.dimension_id as string | null) ?? null,
    label: String(raw.label ?? "Unassigned"),
    gross: num(raw.gross),
    discount: num(raw.discount),
    net_purchases: num(raw.net_purchases),
    tax: num(raw.tax),
    returns: num(raw.returns),
    net_after_returns: num(raw.net_after_returns),
    quantity: num(raw.quantity),
    purchase_documents: Number(raw.purchase_documents ?? 0) || 0,
    return_documents: Number(raw.return_documents ?? 0) || 0,
  };
}

/**
 * One page of the purchase analysis for a single dimension.
 * Pass `limit: null` for the export path — never re-aggregate the visible page.
 */
export async function fetchPurchaseAnalysis(
  params: PurchaseAnalysisParams,
): Promise<PurchaseAnalysisResult> {
  const { data, error } = await (supabase.rpc as any)("finance_purchase_analysis", {
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
  const unconvertible = (payload.unconvertible ?? {}) as Record<string, unknown>;

  return {
    dimension: isPurchaseDimension(payload.dimension) ? payload.dimension : params.dimension,
    from: String(payload.from ?? params.from),
    to: String(payload.to ?? params.to),
    rows: rows.map(normalizeRow),
    totals: {
      gross: num(totals.gross),
      discount: num(totals.discount),
      net_purchases: num(totals.net_purchases),
      tax: num(totals.tax),
      returns: num(totals.returns),
      net_after_returns: num(totals.net_after_returns),
      quantity: num(totals.quantity),
      purchase_documents: Number(totals.purchase_documents ?? 0) || 0,
      return_documents: Number(totals.return_documents ?? 0) || 0,
      unconvertible_document_count: Number(totals.unconvertible_document_count ?? 0) || 0,
    },
    unconvertible: {
      purchase_documents: Number(unconvertible.purchase_documents ?? 0) || 0,
      return_documents: Number(unconvertible.return_documents ?? 0) || 0,
      total: Number(unconvertible.total ?? 0) || 0,
    },
    paging: {
      total_rows: Number(paging.total_rows ?? 0) || 0,
      limit: (paging.limit as number | null) ?? null,
      offset: Number(paging.offset ?? 0) || 0,
    },
  };
}

export interface PurchaseExpenseReconciliation {
  from: string;
  to: string;
  documentNetPurchases: number;
  documentPurchases: number;
  documentReturns: number;
  glPurchaseDebits: number;
  glPurchaseReturns: number;
  ledgerNetPurchases: number;
  variance: number;
  /** Bills in range with no conversion evidence; excluded from the document side. */
  unconvertibleBillCount: number;
  /** Vendor credit notes in range with no conversion evidence; excluded from the document side. */
  unconvertibleVendorCreditNoteCount: number;
  unconvertibleDocumentCount: number;
  /** False while any document is unconvertible — an unknown value is not a tie-out. */
  inBalance: boolean;
}

/**
 * Tie document net purchases to the ledger postings those very documents
 * produced (AP control and input tax excluded). A non-zero variance is a
 * bookkeeping finding — surface it, never tune the report to hide it.
 */
export async function fetchPurchaseExpenseReconciliation(params: {
  orgId: string;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
}): Promise<PurchaseExpenseReconciliation | null> {
  const { data, error } = await (supabase.rpc as any)(
    "finance_purchase_expense_reconciliation",
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
    documentNetPurchases: num(row.document_net_purchases),
    documentPurchases: num(row.document_purchases),
    documentReturns: num(row.document_returns),
    glPurchaseDebits: num(row.gl_purchase_debits),
    glPurchaseReturns: num(row.gl_purchase_returns),
    ledgerNetPurchases: num(row.ledger_net_purchases),
    variance: num(row.variance),
    unconvertibleBillCount: Number(row.unconvertible_bill_count ?? 0) || 0,
    unconvertibleVendorCreditNoteCount: Number(row.unconvertible_vendor_credit_note_count ?? 0) || 0,
    unconvertibleDocumentCount: Number(row.unconvertible_document_count ?? 0) || 0,
    inBalance: Boolean(row.in_balance),
  };
}
