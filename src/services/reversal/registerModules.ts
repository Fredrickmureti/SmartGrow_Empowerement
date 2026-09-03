/**
 * Canonical inventory of reversible business documents.
 *
 * This list is the contract between three things:
 *   1. the `public.reversal_register` view, which must contain one branch per
 *      entry here,
 *   2. the finance reversal-register screen's module/document filters,
 *   3. the governance action keys used for reversal approvals.
 *
 * Microfinance scope: the only reversible financial documents are loan
 * disbursements and loan repayments. Adding a new reversible document type
 * means adding it here FIRST, then extending the register view.
 */

export type ReversalModule = "lending" | "collections";

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
  lending: "Lending",
  collections: "Collections",
};

export const REVERSIBLE_DOCUMENTS: ReversibleDocument[] = [
  {
    documentType: "loan_disbursement",
    module: "lending",
    label: "Loan disbursement",
    table: "mf_loan_disbursements",
  },
  {
    documentType: "loan_repayment",
    module: "collections",
    label: "Loan repayment",
    table: "mf_repayments",
  },
];

export const documentLabel = (documentType: string): string =>
  REVERSIBLE_DOCUMENTS.find((d) => d.documentType === documentType)?.label ?? documentType;
