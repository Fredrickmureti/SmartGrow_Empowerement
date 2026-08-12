/**
 * Canonical inventory of reversible business documents (ADR 0129, Phase 5.4).
 *
 * This list is the contract between three things:
 *   1. the `public.reversal_register` view, which must contain one branch per
 *      entry here (enforced by
 *      `src/test/architecture/reversal-register-coverage.test.ts`),
 *   2. the finance reversal-register screen's module/document filters,
 *   3. the governance action keys used for reversal approvals.
 *
 * Adding a new reversible document type means adding it here FIRST — the guard
 * test then fails until the register view and the screen cover it, which is the
 * point: no module may reverse business state invisibly.
 */

export type ReversalModule =
  | "sales"
  | "purchases"
  | "receiving"
  | "pos"
  | "payroll";

export interface ReversibleDocument {
  /** Matches `reversal_register.document_type`. */
  documentType: string;
  /** Matches `reversal_register.module`. */
  module: ReversalModule;
  label: string;
  /** Source table the register branch reads from. */
  table: string;
}

export const REVERSAL_MODULE_LABELS: Record<ReversalModule, string> = {
  sales: "Sales",
  purchases: "Purchases",
  receiving: "Receiving",
  pos: "Point of sale",
  payroll: "Payroll",
};

export const REVERSIBLE_DOCUMENTS: ReversibleDocument[] = [
  { documentType: "invoice", module: "sales", label: "Customer invoice", table: "invoices" },
  { documentType: "payment", module: "sales", label: "Customer payment", table: "payments" },
  {
    documentType: "customer_refund",
    module: "sales",
    label: "Customer refund",
    table: "customer_refunds",
  },
  { documentType: "bill", module: "purchases", label: "Supplier bill", table: "bills" },
  {
    documentType: "bill_payment",
    module: "purchases",
    label: "Supplier payment",
    table: "bill_payments",
  },
  { documentType: "expense", module: "purchases", label: "Expense", table: "expenses" },
  {
    documentType: "vendor_credit_note",
    module: "purchases",
    label: "Vendor credit note",
    table: "vendor_credit_notes",
  },
  {
    documentType: "goods_receipt",
    module: "receiving",
    label: "Goods receipt",
    table: "goods_receipts",
  },
  {
    documentType: "pos_transaction",
    module: "pos",
    label: "POS transaction",
    table: "pos_transactions",
  },
  { documentType: "payroll_run", module: "payroll", label: "Payroll run", table: "payroll_runs" },
];

export const documentLabel = (documentType: string): string =>
  REVERSIBLE_DOCUMENTS.find((d) => d.documentType === documentType)?.label ?? documentType;
