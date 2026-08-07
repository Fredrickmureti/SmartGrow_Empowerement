/**
 * Account Sub-Classification — browser side.
 *
 * Phase 3 of the reporting convergence roadmap turned this file into a thin
 * binding over the shared accounting kernel
 * (`supabase/functions/_shared/reports/accountingKernel.ts`). The kernel is
 * the ONE definition of IAS 1 sub-typing, the code-range fallback, the
 * sub-type labels and the statement section ordering; the server report
 * engine (`_shared/reportDataEngine.ts`) binds to the very same module.
 * Previously both sides carried their own copy and had already drifted
 * (equity `>= 3200` on the server vs `3200..3999` here), which is exactly
 * how an on-screen statement and its archived PDF start disagreeing.
 *
 * What stays here: the browser's authoritative detail-type table lookup
 * (`@/lib/accountDetailTypeClassification`, which also carries behavioural
 * flags such as isBank / isReceivable) and the rendering-oriented
 * `ClassifiedAccount` shape.
 *
 * Code-range fallback (kernel):
 * - 1000-1499 Current Assets · 1500-1999 Non-Current Assets
 * - 2000-2499 Current Liabilities · 2500-2999 Non-Current Liabilities
 * - 3000-3099 Share Capital · 3100-3199 Retained Earnings · 3200-3999 Reserves
 * - 4000-4499 Revenue · 4500-4999 Other Income
 * - 5000-5499 Cost of Sales · 5500-6999 Operating Expenses
 * - 7000-7499 Other Expenses · 7500-7999 Tax Expense · 8000-8999 Other
 */
import { getSubTypeFromDetailType } from "@/lib/accountDetailTypeClassification";
import {
  classifyAccount as kernelClassifyAccount,
  type AccountSubType as KernelAccountSubType,
  type AssetSubType as KernelAssetSubType,
  type EquitySubType as KernelEquitySubType,
  type ExpenseSubType as KernelExpenseSubType,
  type IncomeSubType as KernelIncomeSubType,
  type LiabilitySubType as KernelLiabilitySubType,
} from "../../../supabase/functions/_shared/reports/accountingKernel";

export {
  BS_ASSET_ORDER,
  BS_EQUITY_ORDER,
  BS_LIABILITY_ORDER,
  PNL_EXPENSE_ORDER,
  PNL_INCOME_ORDER,
  SUB_TYPE_LABELS,
  classifyByCodeRange,
  extractCodeNumber,
} from "../../../supabase/functions/_shared/reports/accountingKernel";

export type AssetSubType = KernelAssetSubType;
export type LiabilitySubType = KernelLiabilitySubType;
export type EquitySubType = KernelEquitySubType;
export type IncomeSubType = KernelIncomeSubType;
export type ExpenseSubType = KernelExpenseSubType;
export type AccountSubType = KernelAccountSubType;

export interface ClassifiedAccount {
  id: string;
  code: string;
  name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  sub_type: AccountSubType;
  closing_balance: number;
  opening_balance: number;
  debit_total: number;
  credit_total: number;
  display_amount: number;
  depth: number;
  is_group: boolean;
  parent_id: string | null;
  comparison_amount?: number;
  variance?: number;
  variance_percent?: number | null;
}

/**
 * Sub-type for an account: authoritative `detail_type` mapping first,
 * code-range inference as the fallback for legacy accounts.
 */
export function classifyAccount(
  accountType: "asset" | "liability" | "equity" | "income" | "expense",
  code: string,
  detailType?: string | null,
): AccountSubType {
  return kernelClassifyAccount(accountType, code, detailType, getSubTypeFromDetailType);
}

/** Groups classified accounts by their sub-type within a section. */
export function groupBySubType<T extends { sub_type: AccountSubType }>(
  accounts: T[],
): Map<AccountSubType, T[]> {
  const groups = new Map<AccountSubType, T[]>();
  for (const acct of accounts) {
    const existing = groups.get(acct.sub_type) || [];
    existing.push(acct);
    groups.set(acct.sub_type, existing);
  }
  return groups;
}
