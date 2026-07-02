import { getSubTypeFromDetailType } from "@/lib/accountDetailTypeClassification";

/**
 * Account Sub-Classification System
 * 
 * Maps accounts to standard IAS 1 / IFRS sub-categories based on
 * account code ranges. This avoids a database migration by deriving
 * classification from the chart of accounts numbering convention.
 * 
 * Standard code ranges (configurable per organization):
 * - 1000-1499: Current Assets
 * - 1500-1999: Non-Current Assets
 * - 2000-2499: Current Liabilities
 * - 2500-2999: Non-Current Liabilities
 * - 3000-3999: Equity
 * - 4000-4499: Revenue
 * - 4500-4999: Other Income
 * - 5000-5499: Cost of Sales / COGS
 * - 5500-5999: Operating Expenses (primary)
 * - 6000-6999: Operating Expenses (secondary)
 * - 7000-7499: Other Expenses
 * - 7500-7999: Tax Expense
 * - 8000-8999: Other Income/Expenses
 * - 9000-9999: Suspense / Control accounts (classified by account_type)
 */

export type AssetSubType = "current_asset" | "non_current_asset";
export type LiabilitySubType = "current_liability" | "non_current_liability";
export type EquitySubType = "share_capital" | "retained_earnings" | "reserves";
export type IncomeSubType = "revenue" | "other_income";
export type ExpenseSubType = "cost_of_sales" | "operating_expense" | "other_expense" | "tax_expense";

export type AccountSubType =
  | AssetSubType
  | LiabilitySubType
  | EquitySubType
  | IncomeSubType
  | ExpenseSubType;

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
 * Extracts the numeric prefix from an account code for range-based classification.
 * Handles codes like "1000", "1000.01", "1000-Cash", etc.
 */
function extractCodeNumber(code: string): number {
  const match = code.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Classifies an asset account into current or non-current
 */
function classifyAsset(codeNum: number): AssetSubType {
  if (codeNum >= 1500 && codeNum < 2000) return "non_current_asset";
  return "current_asset";
}

/**
 * Classifies a liability account into current or non-current
 */
function classifyLiability(codeNum: number): LiabilitySubType {
  if (codeNum >= 2500 && codeNum < 3000) return "non_current_liability";
  return "current_liability";
}

/**
 * Classifies an equity account
 */
function classifyEquity(codeNum: number): EquitySubType {
  if (codeNum >= 3100 && codeNum < 3200) return "retained_earnings";
  if (codeNum >= 3200 && codeNum < 4000) return "reserves";
  return "share_capital";
}

/**
 * Classifies an income account
 */
function classifyIncome(codeNum: number): IncomeSubType {
  if (codeNum >= 4500 && codeNum < 5000) return "other_income";
  if (codeNum >= 8000 && codeNum < 9000) return "other_income";
  return "revenue";
}

/**
 * Classifies an expense account
 */
function classifyExpense(codeNum: number): ExpenseSubType {
  if (codeNum >= 5000 && codeNum < 5500) return "cost_of_sales";
  if (codeNum >= 7500 && codeNum < 8000) return "tax_expense";
  if (codeNum >= 7000 && codeNum < 7500) return "other_expense";
  if (codeNum >= 8000 && codeNum < 9000) return "other_expense";
  return "operating_expense";
}

/**
 * Determines the sub-type for any account based on its type, code, and detail_type.
 * 
 * Priority:
 * 1. detail_type metadata (authoritative — from user selection)
 * 2. Code-range inference (fallback — for legacy accounts without detail_type)
 */
export function classifyAccount(
  accountType: "asset" | "liability" | "equity" | "income" | "expense",
  code: string,
  detailType?: string | null
): AccountSubType {
  // Primary: use detail_type if available and mapped
  if (detailType) {
    const subType = getSubTypeFromDetailType(detailType);
    if (subType) return subType;
  }

  // Fallback: code-range inference for legacy accounts
  const codeNum = extractCodeNumber(code);

  switch (accountType) {
    case "asset":
      return classifyAsset(codeNum);
    case "liability":
      return classifyLiability(codeNum);
    case "equity":
      return classifyEquity(codeNum);
    case "income":
      return classifyIncome(codeNum);
    case "expense":
      return classifyExpense(codeNum);
  }
}

/**
 * Groups classified accounts by their sub-type within a section
 */
export function groupBySubType<T extends { sub_type: AccountSubType }>(
  accounts: T[]
): Map<AccountSubType, T[]> {
  const groups = new Map<AccountSubType, T[]>();
  for (const acct of accounts) {
    const existing = groups.get(acct.sub_type) || [];
    existing.push(acct);
    groups.set(acct.sub_type, existing);
  }
  return groups;
}

// ─── Display Labels ─────────────────────────────────────────────────

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

// ─── Section Ordering ───────────────────────────────────────────────

/** Balance Sheet sub-type ordering within each major section */
export const BS_ASSET_ORDER: AssetSubType[] = ["current_asset", "non_current_asset"];
export const BS_LIABILITY_ORDER: LiabilitySubType[] = ["current_liability", "non_current_liability"];
export const BS_EQUITY_ORDER: EquitySubType[] = ["share_capital", "retained_earnings", "reserves"];

/** P&L sub-type ordering */
export const PNL_INCOME_ORDER: IncomeSubType[] = ["revenue", "other_income"];
export const PNL_EXPENSE_ORDER: ExpenseSubType[] = ["cost_of_sales", "operating_expense", "other_expense", "tax_expense"];
