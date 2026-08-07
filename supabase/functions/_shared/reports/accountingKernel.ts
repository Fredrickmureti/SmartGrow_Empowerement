/**
 * Accounting kernel — the ONE definition of the accounting primitives that
 * both the browser reporting engine and the server report engine depend on.
 *
 * Phase 3 of the reporting convergence roadmap. Before this file:
 *
 *   - `isDebitNormal` existed in `src/services/reports/ReportCalculationEngine.ts`
 *     and again in `supabase/functions/_shared/reportDataEngine.ts`.
 *   - The IAS 1 code-range fallback classification existed in
 *     `src/services/reports/AccountClassification.ts` (as five small
 *     functions) and again, hand-copied and already slightly divergent, in
 *     `reportDataEngine.ts` (equity `>= 3200` vs `3200..3999`).
 *   - `SUB_TYPE_LABELS` and the balance-sheet / P&L sub-type ordering were
 *     duplicated the same way.
 *
 * A drift in any of these makes the on-screen statement and the archived
 * PDF of the *same period* disagree — the defect class this roadmap exists
 * to remove.
 *
 * This module lives under `supabase/functions/_shared` because edge
 * functions can only import from there, and it is deliberately
 * dependency-free (no Deno URL imports, no `@/` aliases) so Vite can bundle
 * it into the browser build too. `src/lib/receipt/preview/buildReceiptLines.ts`
 * follows the same shared-kernel pattern.
 *
 * Detail-type classification (the authoritative source, used ahead of the
 * code-range fallback) still has a rich client-side table with behavioural
 * flags in `src/lib/accountDetailTypeClassification.ts`; the server keeps a
 * sub-type-only projection of it. Those two are pinned together by
 * `src/test/architecture/accounting-kernel-parity.test.ts`, which fails on
 * any missing or mismatched detail type.
 */

export type AssetSubType = "current_asset" | "non_current_asset";
export type LiabilitySubType = "current_liability" | "non_current_liability";
export type EquitySubType = "share_capital" | "retained_earnings" | "reserves";
export type IncomeSubType = "revenue" | "other_income";
export type ExpenseSubType =
  | "cost_of_sales"
  | "operating_expense"
  | "other_expense"
  | "tax_expense";

export type AccountSubType =
  | AssetSubType
  | LiabilitySubType
  | EquitySubType
  | IncomeSubType
  | ExpenseSubType;

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** Assets and expenses increase on the debit side. */
export function isDebitNormal(accountType: string): boolean {
  return accountType === "asset" || accountType === "expense";
}

/**
 * Closing balance from an opening balance plus period movement, signed in
 * the account's natural direction.
 */
export function calculateBalance(
  accountType: string,
  openingBalance: number,
  debits: number,
  credits: number,
): number {
  return isDebitNormal(accountType)
    ? openingBalance + debits - credits
    : openingBalance + credits - debits;
}

/** Numeric prefix of a code: "1000", "1000.01", "1000-Cash" → 1000. */
export function extractCodeNumber(code: string): number {
  const match = (code || "").match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * IAS 1 sub-type inferred from the chart-of-accounts numbering convention.
 * This is the FALLBACK — `detail_type` wins whenever it is set and mapped.
 *
 * 1000-1499 current assets · 1500-1999 non-current assets
 * 2000-2499 current liabilities · 2500-2999 non-current liabilities
 * 3000-3099 share capital · 3100-3199 retained earnings · 3200+ reserves
 * 4000-4499 revenue · 4500-4999 + 8000-8999 other income
 * 5000-5499 cost of sales · 5500-6999 operating expenses
 * 7000-7499 + 8000-8999 other expenses · 7500-7999 tax expense
 */
export function classifyByCodeRange(accountType: string, code: string): AccountSubType {
  const codeNum = extractCodeNumber(code);
  switch (accountType) {
    case "asset":
      return codeNum >= 1500 && codeNum < 2000 ? "non_current_asset" : "current_asset";
    case "liability":
      return codeNum >= 2500 && codeNum < 3000
        ? "non_current_liability"
        : "current_liability";
    case "equity":
      if (codeNum >= 3100 && codeNum < 3200) return "retained_earnings";
      if (codeNum >= 3200 && codeNum < 4000) return "reserves";
      return "share_capital";
    case "income":
      return (codeNum >= 4500 && codeNum < 5000) || (codeNum >= 8000 && codeNum < 9000)
        ? "other_income"
        : "revenue";
    case "expense":
      if (codeNum >= 5000 && codeNum < 5500) return "cost_of_sales";
      if (codeNum >= 7500 && codeNum < 8000) return "tax_expense";
      if ((codeNum >= 7000 && codeNum < 7500) || (codeNum >= 8000 && codeNum < 9000))
        return "other_expense";
      return "operating_expense";
    default:
      return "current_asset";
  }
}

/**
 * Full classification: authoritative detail-type mapping first, code range
 * second. Callers pass their own detail-type lookup so the client can use
 * its flag-bearing table and the server its projection — both resolve the
 * same sub-type because the parity test pins the two tables together.
 */
export function classifyAccount(
  accountType: string,
  code: string,
  detailType: string | null | undefined,
  lookupDetailType: (dt: string) => AccountSubType | undefined,
): AccountSubType {
  if (detailType) {
    const fromDetail = lookupDetailType(detailType);
    if (fromDetail) return fromDetail;
  }
  return classifyByCodeRange(accountType, code);
}

export const SUB_TYPE_LABELS: Record<AccountSubType, string> = {
  current_asset: "Current Assets",
  non_current_asset: "Non-Current Assets",
  current_liability: "Current Liabilities",
  non_current_liability: "Non-Current Liabilities",
  share_capital: "Equity",
  retained_earnings: "Retained Earnings",
  reserves: "Reserves",
  revenue: "Revenue",
  other_income: "Other Income",
  cost_of_sales: "Cost of Sales",
  operating_expense: "Operating Expenses",
  other_expense: "Other Expenses",
  tax_expense: "Tax Expense",
};

/** Balance-sheet sub-type ordering within each major section. */
export const BS_ASSET_ORDER: AssetSubType[] = ["current_asset", "non_current_asset"];
export const BS_LIABILITY_ORDER: LiabilitySubType[] = [
  "current_liability",
  "non_current_liability",
];
export const BS_EQUITY_ORDER: EquitySubType[] = [
  "share_capital",
  "retained_earnings",
  "reserves",
];

/** P&L sub-type ordering. */
export const PNL_INCOME_ORDER: IncomeSubType[] = ["revenue", "other_income"];
export const PNL_EXPENSE_ORDER: ExpenseSubType[] = [
  "cost_of_sales",
  "operating_expense",
  "other_expense",
  "tax_expense",
];

export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};
