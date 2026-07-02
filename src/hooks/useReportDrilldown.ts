/**
 * useReportDrilldown — Stage E
 *
 * The unified reporting engine preserves a `_meta` field on every row that
 * `reportDataEngine.ts` produces server-side. The PDF renderer ignores it
 * (PDFs are static documents), but the on-screen report viewer can use it
 * to wire row clicks back to the source-of-truth detail page.
 *
 * Contract (mirrored in supabase/functions/_shared/reports/README.md):
 *
 *   _meta?: {
 *     accountId?:      string;   // → /finance/accounts/:id
 *     journalId?:      string;   // → /finance/journal-entries/:id
 *     sourceDocType?:  "invoice" | "bill" | "credit_note" | "payment" | "journal_entry";
 *     sourceDocId?:    string;
 *     partnerId?:      string;
 *     partnerType?:    "customer" | "supplier";
 *   }
 *
 * Resolution priority (most specific wins):
 *   1. sourceDocType + sourceDocId — drills into the originating document
 *   2. journalId                  — drills into the JE
 *   3. accountId                  — drills into the account ledger
 *   4. partnerId + partnerType    — drills into the partner statement
 */

export interface ReportRowMeta {
  accountId?: string;
  journalId?: string;
  sourceDocType?:
    | "invoice"
    | "bill"
    | "credit_note"
    | "debit_note"
    | "payment"
    | "journal_entry"
    | "expense"
    | "asset"
    | "payslip"
    | "payroll_run";
  sourceDocId?: string;
  partnerId?: string;
  partnerType?: "customer" | "supplier";
}

export interface DrilldownTarget {
  /** App-relative path. Caller passes to `navigate()` or `<Link to>`. */
  path: string;
  /** Human-readable hint for tooltips ("View invoice INV-001"). */
  label: string;
}

/**
 * For each source-doc type, the base path of the page that owns its detail
 * view. List pages with `?id=...` deep-link support are used where dedicated
 * per-id routes don't exist; per-id RESTful routes are preferred when they
 * do (currently: journal_entry).
 */
const SOURCE_DOC_PATHS: Record<NonNullable<ReportRowMeta["sourceDocType"]>, string> = {
  invoice: "/sales/invoices",
  bill: "/purchases/bills",
  credit_note: "/finance/customer-credits",
  debit_note: "/purchases/debit-notes",
  payment: "/sales/invoices",
  journal_entry: "/finance/journal-entries",
  expense: "/purchases/expenses",
  asset: "/finance/fixed-assets",
  payslip: "/hr/payroll/payslips",
  payroll_run: "/hr/payroll/runs",
};

export function getDrilldownTarget(
  meta: ReportRowMeta | undefined | null,
): DrilldownTarget | null {
  if (!meta) return null;

  // 1. Source document — most specific
  if (meta.sourceDocType && meta.sourceDocId) {
    const base = SOURCE_DOC_PATHS[meta.sourceDocType];
    if (base) {
      // Per-id RESTful route for JEs; ?id deep-link for list-based pages.
      const path =
        meta.sourceDocType === "journal_entry" ||
        meta.sourceDocType === "payslip" ||
        meta.sourceDocType === "payroll_run"
          ? `${base}/${meta.sourceDocId}`
          : `${base}?id=${meta.sourceDocId}`;
      return {
        path,
        label: `View ${meta.sourceDocType.replace(/_/g, " ")}`,
      };
    }
  }

  // 2. Journal entry
  if (meta.journalId) {
    return {
      path: `/finance/journal-entries/${meta.journalId}`,
      label: "View journal entry",
    };
  }

  // 3. Account ledger
  if (meta.accountId) {
    return {
      path: `/finance/accounts/${meta.accountId}`,
      label: "View account ledger",
    };
  }

  // 4. Partner statement (unified contact profile page)
  if (meta.partnerId && meta.partnerType) {
    return {
      path: `/contacts-app/profile?id=${meta.partnerId}`,
      label: `View ${meta.partnerType} statement`,
    };
  }

  return null;
}

/**
 * Hook variant — currently a thin wrapper around `getDrilldownTarget`,
 * kept as a hook so future enhancements (audit-trail logging of clicks,
 * permission checks via `usePermissions`, route-context resolution) can
 * land without touching every call site.
 */
export function useReportDrilldown() {
  return { getDrilldownTarget };
}
