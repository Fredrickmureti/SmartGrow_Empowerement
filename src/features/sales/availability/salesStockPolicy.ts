/**
 * Sales stock policy — what each Sales document promises about stock.
 *
 * Phase 5 of the Sales domain wave. Availability itself is a SERVER decision
 * (ADR 0142: `resolve_stock_availability` / `resolve_stock_availability_batch`,
 * surfaced to Sales editors through `list_products_with_branch_stock` →
 * `useBranchScopedProducts`). This module answers the separate question the
 * database cannot answer for us: *what should the operator be allowed to do
 * when the number is short?*
 *
 * That is a commercial policy, and it differs per document:
 *
 *   commit    — the document creates a commitment against physical stock, so
 *               overselling must be a deliberate, recorded act: the operator
 *               sees which lines are short and must tick a confirmation.
 *   advisory  — the document is an offer, not a commitment. Show the operator
 *               the stock position so they can quote honestly, but never block:
 *               quoting for stock you intend to buy is normal trade.
 *   none      — the document has no product lines, or its quantities are
 *               provenance from a source document rather than a fresh demand
 *               (credit notes, returns), so a stock check would be noise.
 *
 * Every Sales document that captures product lines MUST appear here. The
 * architecture guard `src/test/architecture/sales-availability-coverage.test.ts`
 * fails if a line-capturing Sales editor has no entry, so a new document
 * cannot ship without an explicit stock decision.
 */

export type SalesStockPolicy = "commit" | "advisory" | "none";

export type SalesDocumentKind =
  | "invoice"
  | "sales_order"
  | "delivery_note"
  | "estimate"
  | "proforma"
  | "credit_note"
  | "sales_return";

export const SALES_STOCK_POLICY: Record<SalesDocumentKind, SalesStockPolicy> = {
  // Committed sale — the goods are promised, and (for invoices) revenue and
  // COGS follow. Oversell is allowed but must be confirmed.
  invoice: "commit",
  // Confirmation reserves stock (`confirm_sales_order_atomic` →
  // `reserve_stock_atomic`); a short line becomes a skipped reservation, so the
  // operator must know before they commit.
  sales_order: "commit",
  // Physical goods leaving the building. Strictest surface.
  delivery_note: "commit",
  // Offers. Advisory only — never block a quote on today's stock.
  estimate: "advisory",
  proforma: "advisory",
  // Quantities come from the source invoice / shipment, not from fresh demand,
  // and the movement is inbound.
  credit_note: "none",
  sales_return: "none",
};

/** Human wording used in the oversell confirmation for each document. */
export const SALES_DOCUMENT_LABEL: Record<SalesDocumentKind, string> = {
  invoice: "invoice",
  sales_order: "sales order",
  delivery_note: "delivery note",
  estimate: "estimate",
  proforma: "proforma invoice",
  credit_note: "credit note",
  sales_return: "sales return",
};

export const stockPolicyFor = (kind: SalesDocumentKind): SalesStockPolicy =>
  SALES_STOCK_POLICY[kind];
