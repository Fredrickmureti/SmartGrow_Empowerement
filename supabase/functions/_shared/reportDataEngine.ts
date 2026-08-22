/**
 * Shared Report Data Engine
 * 
 * Single source of truth for financial report computation.
 * Used by both the scheduled reports Edge Function and any other
 * report generation path. Mirrors the frontend ReportCalculationEngine.ts
 * and AccountClassification.ts logic exactly.
 * 
 * This eliminates the architectural flaw of having two divergent engines.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  BS_ASSET_ORDER,
  BS_EQUITY_ORDER,
  BS_LIABILITY_ORDER,
  PNL_EXPENSE_ORDER,
  PNL_INCOME_ORDER,
  SUB_TYPE_LABELS,
  classifyAccount,
  isDebitNormal,
  type AccountSubType,
} from "./reports/accountingKernel.ts";

// ── Types ──────────────────────────────────────────────────────────────

export type { AccountSubType };

export interface AccountWithBalance {
  id: string;
  code: string;
  name: string;
  account_type: string;
  detail_type: string | null;
  parent_id: string | null;
  opening_balance: number;
  debit_total: number;
  credit_total: number;
  closing_balance: number;
}

export interface ClassifiedRow {
  name: string;
  code?: string;
  closing_balance?: number;
  balance?: number;
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
  _depth?: number;
  _bold?: boolean;
}

export interface ReportResult {
  data: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

// ── Classification Maps (mirrored from accountDetailTypeClassification.ts) ──

export const DETAIL_TYPE_TO_SUB_TYPE: Record<string, AccountSubType> = {
  // Assets: Current
  accounts_receivable: "current_asset", cash_and_cash_equivalents: "current_asset",
  cash_on_hand: "current_asset", checking: "current_asset", savings: "current_asset",
  money_market: "current_asset", mobile_money: "current_asset", trust_account: "current_asset",
  rents_held_in_trust: "current_asset", allowance_bad_debts: "current_asset",
  assets_available_for_sale: "current_asset", development_costs: "current_asset",
  employee_advances: "current_asset", inventory: "current_asset",
  investment_government: "current_asset", investment_tax_exempt: "current_asset",
  loans_to_officers: "current_asset", loans_to_others: "current_asset",
  loans_to_stockholders: "current_asset", prepaid_expenses: "current_asset",
  retainage: "current_asset", short_term_investments: "current_asset",
  undeposited_funds: "current_asset", other_current_asset: "current_asset",
  // Assets: Non-Current
  accumulated_depreciation: "non_current_asset", accumulated_depletion: "non_current_asset",
  buildings: "non_current_asset", depletable_assets: "non_current_asset",
  fixed_asset_computers: "non_current_asset", fixed_asset_copiers: "non_current_asset",
  fixed_asset_furniture: "non_current_asset", fixed_asset_phone: "non_current_asset",
  fixed_asset_photo_video: "non_current_asset", fixed_asset_software: "non_current_asset",
  fixed_asset_other_tools: "non_current_asset", furniture_fixtures: "non_current_asset",
  intangible_assets: "non_current_asset", land: "non_current_asset",
  leasehold_improvements: "non_current_asset", machinery_equipment: "non_current_asset",
  other_fixed_asset: "non_current_asset", vehicles: "non_current_asset",
  accumulated_amortization: "non_current_asset", assets_held_for_sale: "non_current_asset",
  deferred_tax_asset: "non_current_asset", goodwill: "non_current_asset",
  lease_buyout: "non_current_asset", licenses: "non_current_asset",
  long_term_investments: "non_current_asset", organizational_costs: "non_current_asset",
  security_deposits: "non_current_asset", other_non_current_asset: "non_current_asset",
  // Liabilities: Current
  accounts_payable: "current_liability", credit_card: "current_liability",
  accrued_liabilities: "current_liability", trust_accounts_liability_current: "current_liability",
  current_tax_liability: "current_liability", finance_lease_current: "current_liability",
  dividends_payable: "current_liability", insurance_payable: "current_liability",
  line_of_credit: "current_liability", loan_payable_current: "current_liability",
  payroll_clearing: "current_liability", payroll_liabilities: "current_liability",
  payroll_tax_payable: "current_liability", prepaid_expenses_payable: "current_liability",
  rents_in_trust_liability: "current_liability", sales_tax_payable: "current_liability",
  state_local_tax_payable: "current_liability", trust_accounts_liability: "current_liability",
  unearned_revenue: "current_liability", other_current_liability: "current_liability",
  // Liabilities: Non-Current
  accrued_holiday_payable: "non_current_liability", accrued_non_current_liabilities: "non_current_liability",
  liabilities_held_for_sale: "non_current_liability", long_term_borrowings: "non_current_liability",
  lease_obligations: "non_current_liability", notes_payable: "non_current_liability",
  shareholder_notes_payable: "non_current_liability", other_non_current_liability: "non_current_liability",
  // Equity
  accumulated_adjustment: "reserves", dividend_disbursed: "reserves",
  equity_in_subsidiaries: "reserves", share_capital: "share_capital",
  estimated_taxes: "reserves", health_insurance_premium: "reserves",
  opening_balance_equity: "reserves", other_comprehensive_income: "reserves",
  owner_contributions: "share_capital", owner_drawings: "reserves",
  owners_equity: "share_capital", paid_in_capital: "share_capital",
  personal_expense: "reserves", personal_income: "reserves",
  preferred_stock: "share_capital", retained_earnings: "retained_earnings",
  treasury_stock: "share_capital", other_equity: "reserves",
  // Income: Revenue
  discount_refund: "revenue", non_profit_income: "revenue", other_primary_income: "revenue",
  revenue_general: "revenue", sales_retail: "revenue", sales_wholesale: "revenue",
  sales_income: "revenue", service_income: "revenue", unapplied_cash_payment_income: "revenue",
  // Income: Other Income
  dividend_income: "other_income", interest_income: "other_income",
  gain_on_asset_sales: "other_income", other_investment_income: "other_income",
  other_operating_income: "other_income", rental_income: "other_income",
  tax_exempt_interest: "other_income", unrealized_loss_securities: "other_income",
  other_income: "other_income",
  // Expense: Cost of Sales
  cost_of_labour: "cost_of_sales", cost_of_goods_sold: "cost_of_sales",
  equipment_rental_cos: "cost_of_sales", freight_delivery_cos: "cost_of_sales",
  supplies_materials_cos: "cost_of_sales", shipping_cos: "cost_of_sales", other_cos: "cost_of_sales",
  // Expense: Operating
  advertising: "operating_expense", amortization: "operating_expense", auto: "operating_expense",
  bad_debts: "operating_expense", bank_charges: "operating_expense",
  charitable_contributions: "operating_expense", commissions_fees: "operating_expense",
  cost_of_labour_expense: "operating_expense", dues_subscriptions: "operating_expense",
  entertainment: "operating_expense", entertainment_meals: "operating_expense",
  equipment_rental: "operating_expense", finance_costs: "operating_expense",
  insurance_expense: "operating_expense", interest_paid: "operating_expense",
  loss_discontinued_operations: "operating_expense", management_compensation: "operating_expense",
  legal_professional_fees: "operating_expense", meals_entertainment: "operating_expense",
  office_expenses: "operating_expense", other_business_expenses: "operating_expense",
  other_selling_expense: "operating_expense", other_misc_service_cost: "operating_expense",
  payroll_expense: "operating_expense", payroll_tax_expense: "operating_expense",
  payroll_wage_expense: "operating_expense", promotional_meals: "operating_expense",
  rent_expense: "operating_expense", repair_maintenance: "operating_expense",
  security_expenses: "operating_expense", shipping_delivery: "operating_expense",
  supplies: "operating_expense", telephone_internet: "operating_expense",
  travel: "operating_expense", travel_meals: "operating_expense",
  travel_selling: "operating_expense", unapplied_cash_bill_payment: "operating_expense",
  utilities: "operating_expense", depreciation: "operating_expense",
  // Expense: Tax
  income_tax_expense: "tax_expense", taxes_paid: "tax_expense",
  // Expense: Other
  exchange_gain_loss: "other_expense", penalties: "other_expense",
  loss_on_asset_sales: "other_expense", other_expense: "other_expense",
};

export { SUB_TYPE_LABELS, isDebitNormal };

// ── Core Functions ─────────────────────────────────────────────────────

/**
 * Detail type first (authoritative), code range second. Both halves of the
 * rule now come from the shared kernel, so the server can no longer drift
 * from the browser engine.
 */
export function classifyAccountSubType(
  accountType: string,
  code: string,
  detailType: string | null,
): AccountSubType {
  return classifyAccount(
    accountType,
    code,
    detailType,
    (dt) => DETAIL_TYPE_TO_SUB_TYPE[dt],
  );
}

// ── GL Account Balance Aggregation ─────────────────────────────────────

function requireBusinessId(businessId?: string | null): string {
  if (!businessId) {
    throw new Error("businessId is required for company-level financial reports; use an explicit consolidation flow for cross-company reporting");
  }
  return businessId;
}

/** The day before `startStr` — the cut-off for "prior period" movement. */
function dayBefore(startStr: string): string {
  const d = new Date(`${startStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function accountMovements(
  supabase: SupabaseClient,
  organizationId: string,
  businessId: string,
  from: string,
  to: string,
  branchId?: string,
): Promise<Map<string, { debit: number; credit: number }>> {
  const { data, error } = await supabase.rpc("get_account_movements", {
    _org_id: organizationId,
    _date_from: from,
    _date_to: to,
    _business_id: businessId,
    _branch_id: branchId ?? null,
  });
  if (error) throw new Error(`Failed to fetch account movements: ${error.message}`);
  const map = new Map<string, { debit: number; credit: number }>();
  for (const row of (data || []) as Record<string, unknown>[]) {
    map.set(row.account_id as string, {
      debit: Number(row.total_debit) || 0,
      credit: Number(row.total_credit) || 0,
    });
  }
  return map;
}

/**
 * Account balances for a period.
 *
 * Movement aggregation goes through the `get_account_movements` RPC — the
 * same engine the on-screen Trial Balance uses. It aggregates in SQL, so it
 * is immune to the 1000-row PostgREST cap that used to make these balances
 * quietly wrong on any sizeable ledger, and it applies the one ledger
 * visibility contract (`ledger_visible_journal_statuses`) rather than a
 * hardcoded `status = 'posted'` that dropped reversed originals.
 */
export async function getGLAccountBalances(
  supabase: SupabaseClient,
  organizationId: string,
  businessId: string | undefined,
  startStr: string,
  endStr: string,
  accountTypeFilter?: string[],
  branchId?: string,
): Promise<AccountWithBalance[]> {
  const scopedBusinessId = requireBusinessId(businessId);

  let accountsQuery = supabase
    .from("accounts")
    .select("id, code, name, account_type, detail_type, parent_id, opening_balance, is_active")
    .eq("organization_id", organizationId)
    .eq("business_id", scopedBusinessId)
    .eq("is_active", true)
    .order("code");

  if (accountTypeFilter && accountTypeFilter.length > 0) {
    accountsQuery = accountsQuery.in("account_type", accountTypeFilter);
  }

  const { data: accounts, error: accountsError } = await accountsQuery;
  if (accountsError) throw new Error(`Failed to fetch accounts: ${accountsError.message}`);

  const [periodByAccount, priorByAccount] = await Promise.all([
    accountMovements(supabase, organizationId, scopedBusinessId, startStr, endStr, branchId),
    accountMovements(supabase, organizationId, scopedBusinessId, "1900-01-01", dayBefore(startStr), branchId),
  ]);

  const result: AccountWithBalance[] = [];
  for (const account of (accounts || []) as Record<string, unknown>[]) {
    const id = account.id as string;
    const accountType = account.account_type as string;
    // `accounts.opening_balance` is a business-level property: a branch-scoped
    // run must not carry the whole company's opening position.
    const baseOpening = branchId ? 0 : ((account.opening_balance as number) || 0);
    const prior = priorByAccount.get(id) || { debit: 0, credit: 0 };
    const period = periodByAccount.get(id) || { debit: 0, credit: 0 };

    let openingBalance = baseOpening;
    if (isDebitNormal(accountType)) {
      openingBalance += prior.debit - prior.credit;
    } else {
      openingBalance += prior.credit - prior.debit;
    }

    let closingBalance = openingBalance;
    if (isDebitNormal(accountType)) {
      closingBalance += period.debit - period.credit;
    } else {
      closingBalance += period.credit - period.debit;
    }

    result.push({
      id,
      code: account.code as string,
      name: account.name as string,
      account_type: accountType,
      detail_type: (account.detail_type as string) || null,
      parent_id: account.parent_id as string | null,
      opening_balance: openingBalance,
      debit_total: period.debit,
      credit_total: period.credit,
      closing_balance: closingBalance,
    });
  }

  return result;
}


// ── Report Builders ────────────────────────────────────────────────────


export async function buildBalanceSheet(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const accounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr, ["asset", "liability", "equity"]);
  const incExpAccounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr, ["income", "expense"]);
  const totalIncome = incExpAccounts.filter(a => a.account_type === "income").reduce((s, a) => s + a.closing_balance, 0);
  const totalExpenses = incExpAccounts.filter(a => a.account_type === "expense").reduce((s, a) => s + a.closing_balance, 0);
  const retainedEarnings = totalIncome - totalExpenses;

  const classified = accounts.map(a => ({
    ...a,
    sub_type: classifyAccountSubType(a.account_type, a.code, a.detail_type),
  }));

  const rows: ClassifiedRow[] = [];

  const buildSection = (sectionLabel: string, accountType: string, subTypeOrder: AccountSubType[]) => {
    const sectionAccounts = classified.filter(a => a.account_type === accountType);
    const sectionTotal = sectionAccounts.reduce((s, a) => s + a.closing_balance, 0) +
      (accountType === "equity" ? retainedEarnings : 0);

    rows.push({ name: sectionLabel.toUpperCase(), _isHeader: true, _bold: true });

    for (const subType of subTypeOrder) {
      const group = sectionAccounts.filter(a => a.sub_type === subType);
      if (group.length === 0 && !(subType === "retained_earnings" && retainedEarnings !== 0)) continue;

      rows.push({ name: SUB_TYPE_LABELS[subType], _isHeader: true, _depth: 1 });

      for (const acct of group) {
        if (acct.closing_balance === 0) continue;
        rows.push({ name: acct.name, code: acct.code, closing_balance: acct.closing_balance, _depth: 2 });
      }

      if (subType === "retained_earnings" && retainedEarnings !== 0) {
        rows.push({ name: "Current Year Earnings", closing_balance: retainedEarnings, _depth: 2 });
      }

      const subTotal = group.reduce((s, a) => s + a.closing_balance, 0) +
        (subType === "retained_earnings" ? retainedEarnings : 0);
      rows.push({ name: `Total ${SUB_TYPE_LABELS[subType]}`, closing_balance: subTotal, _isSubtotal: true, _depth: 1 });
    }

    rows.push({ name: `TOTAL ${sectionLabel.toUpperCase()}`, closing_balance: sectionTotal, _isGrandTotal: true, _bold: true });
  };

  buildSection("Assets", "asset", BS_ASSET_ORDER);
  buildSection("Liabilities", "liability", BS_LIABILITY_ORDER);
  buildSection("Equity", "equity", BS_EQUITY_ORDER);

  const totalAssets = classified.filter(a => a.account_type === "asset").reduce((s, a) => s + a.closing_balance, 0);
  const totalLiabilities = classified.filter(a => a.account_type === "liability").reduce((s, a) => s + a.closing_balance, 0);
  const totalEquity = classified.filter(a => a.account_type === "equity").reduce((s, a) => s + a.closing_balance, 0) + retainedEarnings;

  return {
    data: rows as unknown as Record<string, unknown>[],
    summary: { totalAssets, totalLiabilities, totalEquity, retainedEarnings, netAssets: totalAssets - totalLiabilities - totalEquity },
  };
}

export async function buildTrialBalance(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const accounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr);

  /** Splits a balance into debit/credit columns based on natural balance */
  function splitBalance(balance: number, accountType: string): { debit: number; credit: number } {
    const isDebit = isDebitNormal(accountType);
    if (isDebit) {
      return balance >= 0 ? { debit: balance, credit: 0 } : { debit: 0, credit: Math.abs(balance) };
    }
    return balance >= 0 ? { debit: 0, credit: balance } : { debit: Math.abs(balance), credit: 0 };
  }

  const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];
  const TYPE_LABELS: Record<string, string> = {
    asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses",
  };

  // Group accounts by type
  const byType: Record<string, AccountWithBalance[]> = {};
  for (const a of accounts) {
    if (!byType[a.account_type]) byType[a.account_type] = [];
    byType[a.account_type].push(a);
  }

  const rows: Record<string, unknown>[] = [];
  const grandTotals = { openDebit: 0, openCredit: 0, movDebit: 0, movCredit: 0, closeDebit: 0, closeCredit: 0 };

  for (const type of TYPE_ORDER) {
    const group = byType[type] || [];
    if (group.length === 0) continue;

    // Section header
    rows.push({ code: "", name: TYPE_LABELS[type] || type, _isHeader: true });

    for (const acct of group) {
      const openSplit = splitBalance(acct.opening_balance, acct.account_type);
      const closeSplit = splitBalance(acct.closing_balance, acct.account_type);

      grandTotals.openDebit += openSplit.debit;
      grandTotals.openCredit += openSplit.credit;
      grandTotals.movDebit += acct.debit_total;
      grandTotals.movCredit += acct.credit_total;
      grandTotals.closeDebit += closeSplit.debit;
      grandTotals.closeCredit += closeSplit.credit;

      rows.push({
        code: acct.code,
        name: acct.name,
        open_dr: openSplit.debit || null,
        open_cr: openSplit.credit || null,
        mov_dr: acct.debit_total || null,
        mov_cr: acct.credit_total || null,
        close_dr: closeSplit.debit || null,
        close_cr: closeSplit.credit || null,
      });
    }
  }

  // Grand total row
  rows.push({
    code: "", name: "TOTAL", _isGrandTotal: true, _bold: true,
    open_dr: grandTotals.openDebit, open_cr: grandTotals.openCredit,
    mov_dr: grandTotals.movDebit, mov_cr: grandTotals.movCredit,
    close_dr: grandTotals.closeDebit, close_cr: grandTotals.closeCredit,
  });

  return {
    data: rows,
    summary: {
      totalAccounts: accounts.length,
      totalDebits: grandTotals.closeDebit,
      totalCredits: grandTotals.closeCredit,
      difference: grandTotals.closeDebit - grandTotals.closeCredit,
    },
  };
}


export async function buildIncomeStatement(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const accounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr, ["income", "expense"]);
  const classified = accounts.map(a => ({
    ...a,
    sub_type: classifyAccountSubType(a.account_type, a.code, a.detail_type),
    balance: a.closing_balance - a.opening_balance,
  }));

  const rows: ClassifiedRow[] = [];
  let totalIncome = 0;
  let totalCOGS = 0;
  let totalExpenses = 0;

  rows.push({ name: "INCOME", _isHeader: true, _bold: true });
  for (const subType of PNL_INCOME_ORDER) {
    const group = classified.filter(a => a.sub_type === subType && a.account_type === "income");
    if (group.length === 0) continue;
    rows.push({ name: SUB_TYPE_LABELS[subType], _isHeader: true, _depth: 1 });
    for (const acct of group) {
      if (acct.balance === 0) continue;
      rows.push({ name: acct.name, code: acct.code, balance: acct.balance, _depth: 2 });
    }
    const subTotal = group.reduce((s, a) => s + a.balance, 0);
    totalIncome += subTotal;
    rows.push({ name: `Total ${SUB_TYPE_LABELS[subType]}`, balance: subTotal, _isSubtotal: true, _depth: 1 });
  }
  rows.push({ name: "TOTAL INCOME", balance: totalIncome, _isGrandTotal: true, _bold: true });

  const cogsGroup = classified.filter(a => a.sub_type === "cost_of_sales");
  if (cogsGroup.length > 0) {
    rows.push({ name: "COST OF SALES", _isHeader: true, _bold: true });
    for (const acct of cogsGroup) {
      if (acct.balance === 0) continue;
      rows.push({ name: acct.name, code: acct.code, balance: acct.balance, _depth: 1 });
    }
    totalCOGS = cogsGroup.reduce((s, a) => s + a.balance, 0);
    rows.push({ name: "TOTAL COST OF SALES", balance: totalCOGS, _isSubtotal: true, _bold: true });
    rows.push({ name: "GROSS PROFIT", balance: totalIncome - totalCOGS, _isGrandTotal: true, _bold: true });
  }

  rows.push({ name: "EXPENSES", _isHeader: true, _bold: true });
  for (const subType of PNL_EXPENSE_ORDER) {
    if (subType === "cost_of_sales") continue;
    const group = classified.filter(a => a.sub_type === subType);
    if (group.length === 0) continue;
    rows.push({ name: SUB_TYPE_LABELS[subType], _isHeader: true, _depth: 1 });
    for (const acct of group) {
      if (acct.balance === 0) continue;
      rows.push({ name: acct.name, code: acct.code, balance: acct.balance, _depth: 2 });
    }
    const subTotal = group.reduce((s, a) => s + a.balance, 0);
    totalExpenses += subTotal;
    rows.push({ name: `Total ${SUB_TYPE_LABELS[subType]}`, balance: subTotal, _isSubtotal: true, _depth: 1 });
  }
  rows.push({ name: "TOTAL EXPENSES", balance: totalExpenses, _isGrandTotal: true, _bold: true });

  const netIncome = totalIncome - totalCOGS - totalExpenses;
  rows.push({ name: "NET INCOME", balance: netIncome, _isGrandTotal: true, _bold: true });

  return {
    data: rows as unknown as Record<string, unknown>[],
    summary: { totalRevenue: totalIncome, totalCOGS, grossProfit: totalIncome - totalCOGS, totalExpenses, netIncome },
  };
}

/**
 * Cash Flow Statement — a thin projection of the ONE engine.
 *
 * The statement is accounting output and is computed exclusively by
 * `public.finance_cash_flow_statement` (indirect method, base currency,
 * posted journal entries only, closing cash derived independently from the
 * cash accounts' ledger balances). This function renders that payload; it
 * MUST NOT classify accounts, guess what "cash" means, or sum movements.
 *
 * Before this, the export path carried its own three-row heuristic that
 * matched cash accounts by name substring and had no investing, financing,
 * FX or opening/closing cash — so the archived PDF stated a different cash
 * flow from the screen. There is now one engine and two renderers.
 */
export async function buildCashFlow(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined,
  startStr: string, endStr: string, branchId?: string,
): Promise<ReportResult> {
  const { data, error } = await supabase.rpc("finance_cash_flow_statement", {
    _org_id: organizationId,
    _from: startStr,
    _to: endStr,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
  });
  if (error) throw new Error(`finance_cash_flow_statement failed: ${error.message}`);

  const payload = (data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const rows: Record<string, unknown>[] = [];

  const section = (raw: unknown, fallbackLabel: string, resultLabel: string) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const items = Array.isArray(s.items) ? (s.items as Record<string, unknown>[]) : [];
    rows.push({ item: String(s.label ?? fallbackLabel), _kind: "section" });
    for (const it of items) {
      rows.push({ item: String(it.label ?? ""), amount: num(it.amount), _kind: "detail" });
    }
    rows.push({ item: resultLabel, amount: num(s.total), _kind: "major_total" });
    rows.push({ item: "", _kind: "spacer" });
    return num(s.total);
  };

  const operating = section(payload.operating, "Cash flows from operating activities", "Net cash from operating activities");
  const investing = section(payload.investing, "Cash flows from investing activities", "Net cash used in investing activities");
  const financing = section(payload.financing, "Cash flows from financing activities", "Net cash from financing activities");

  const netCashFlow = num(payload.net_cash_flow);
  const fxEffect = num(payload.fx_effect);
  const openingCash = num(payload.opening_cash);
  const closingCash = num(payload.closing_cash);
  const recon = (payload.reconciliation ?? {}) as Record<string, unknown>;
  const residual = num(recon.residual);

  rows.push({ item: "Net increase / (decrease) in cash", amount: netCashFlow, _kind: "calculated_result" });
  if (Math.abs(fxEffect) >= 0.01) {
    rows.push({ item: "Effect of exchange rate changes on cash", amount: fxEffect, _kind: "detail" });
  }
  rows.push({ item: "Cash and cash equivalents at beginning of period", amount: openingCash, _kind: "detail" });
  rows.push({ item: "Cash and cash equivalents at end of period", amount: closingCash, _kind: "grand_total" });
  if (Math.abs(residual) >= 0.01) {
    rows.push({
      item: `Unexplained residual vs ledger cash balance: ${residual.toFixed(2)} — accounts need cash-flow classification`,
      _kind: "note",
    });
  }

  return {
    data: rows,
    summary: {
      netOperatingCashFlow: operating,
      netInvestingCashFlow: investing,
      netFinancingCashFlow: financing,
      netCashFlow,
      fxEffect,
      openingCash,
      closingCash,
      residual,
      inBalance: Math.abs(residual) < 0.01,
    },
  };
}

/**
 * Bank Reconciliation Statement — a thin projection of the ONE engine.
 *
 * The bank-to-book proof is accounting output and is computed exclusively by
 * `public.finance_bank_reconciliation_statement` (single currency, statement
 * lines + posted journal entries, `finance_can_read_org` gated). This
 * function renders that payload; it MUST NOT decide what is outstanding,
 * net anything, or re-derive either balance.
 *
 * Before this, the report had no server build path at all: the export
 * re-shipped the browser's rows, so an archived PDF carried the screen's
 * 200-item truncation and bypassed the canonical column spec.
 */
export async function buildBankReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  businessId: string | undefined,
  asOf: string,
  bankAccountId: string,
  branchId?: string,
): Promise<ReportResult> {
  if (!bankAccountId) {
    throw new Error(
      "bank_reconciliation requires filters.bankAccountId — the proof is per bank account",
    );
  }

  const { data, error } = await supabase.rpc("finance_bank_reconciliation_statement", {
    _org_id: organizationId,
    _bank_account_id: bankAccountId,
    _as_of: asOf,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
  });
  if (error) throw new Error(`finance_bank_reconciliation_statement failed: ${error.message}`);

  const payload = (data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;

  const account = obj(payload.account);
  const bank = obj(payload.bank);
  const book = obj(payload.book);
  const diagnostics = obj(payload.diagnostics);
  const rows: Record<string, unknown>[] = [];

  const group = (raw: unknown, sign: 1 | -1) => {
    const g = obj(raw);
    rows.push({ item: String(g.label ?? ""), amount: sign * num(g.total), _kind: "detail" });
    return g;
  };

  rows.push({ item: "Balance per bank statement", amount: num(bank.statement_balance), _kind: "section" });
  const dit = group(bank.deposits_in_transit, 1);
  const unpresented = group(bank.unpresented_payments, -1);
  rows.push({ item: "Adjusted bank balance", amount: num(bank.adjusted_balance), _kind: "subtotal" });
  rows.push({ item: "", _kind: "spacer" });

  // A null book side is an ABSENCE (no GL account, or one shared by two open
  // bank accounts), never a zero. State it as unstateable rather than proving
  // a difference against a balance that does not exist.
  const bookStated = book.gl_balance !== null && book.gl_balance !== undefined;
  const receipts = obj(book.unrecorded_receipts);
  const charges = obj(book.unrecorded_charges);
  if (bookStated) {
    rows.push({ item: "Balance per books (general ledger)", amount: num(book.gl_balance), _kind: "section" });
    group(book.unrecorded_receipts, 1);
    group(book.unrecorded_charges, -1);
    rows.push({ item: "Adjusted book balance", amount: num(book.adjusted_balance), _kind: "subtotal" });
  } else {
    rows.push({ item: "Balance per books (general ledger)", _kind: "section" });
    rows.push({ item: "Not stateable — the bank account has no attributable general ledger account", _kind: "note" });
  }
  rows.push({ item: "", _kind: "spacer" });

  const residual = payload.residual === null || payload.residual === undefined
    ? null
    : num(payload.residual);
  if (residual === null) {
    rows.push({ item: "Unexplained difference", _kind: "grand_total" });
  } else {
    rows.push({ item: "Unexplained difference", amount: residual, _kind: "grand_total" });
  }


  // Outstanding items, in full. The screen caps its lists for readability;
  // the archived document is the audit artefact and states everything the
  // engine returned, including its own truncation flag.
  const itemSection = (raw: unknown) => {
    const g = obj(raw);
    const items = Array.isArray(g.items) ? (g.items as Record<string, unknown>[]) : [];
    if (items.length === 0) return;
    rows.push({ item: "", _kind: "spacer" });
    rows.push({ item: String(g.label ?? ""), _kind: "section" });
    for (const it of items) {
      const parts = [it.date, it.reference, it.description]
        .map((p) => (p == null ? "" : String(p)))
        .filter(Boolean);
      rows.push({ item: parts.join(" · "), amount: num(it.amount), _kind: "detail" });
    }
    rows.push({ item: `Total ${String(g.label ?? "")}`, amount: num(g.total), _kind: "subtotal" });
    if (g.truncated) {
      rows.push({
        item: `Only the first ${items.length} item(s) are listed — the engine truncated this group`,
        _kind: "note",
      });
    }
  };

  itemSection(dit);
  itemSection(unpresented);
  if (bookStated) {
    itemSection(receipts);
    itemSection(charges);
  }

  const warnings: string[] = [];
  if (diagnostics.gl_account_missing) warnings.push("The bank account has no general ledger account, so the book side cannot be stated.");
  if (diagnostics.gl_account_shared) warnings.push("The general ledger account is shared by more than one open bank account, so the book side is not attributable.");
  if (num(diagnostics.cleared_without_posting) > 0) warnings.push(`${num(diagnostics.cleared_without_posting)} cleared statement line(s) carry no posting.`);
  if (num(diagnostics.gl_currency_fallback_lines) > 0) warnings.push(`${num(diagnostics.gl_currency_fallback_lines)} ledger line(s) fell back from the account currency.`);
  for (const w of warnings) rows.push({ item: w, _kind: "note" });

  return {
    data: rows,
    summary: {
      bankAccount: String(account.name ?? ""),
      currency: String(payload.currency ?? account.currency ?? ""),
      asOf: String(payload.as_of ?? asOf),
      statementBalance: num(bank.statement_balance),
      adjustedBankBalance: num(bank.adjusted_balance),
      glBalance: bookStated ? num(book.gl_balance) : null,
      adjustedBookBalance: bookStated ? num(book.adjusted_balance) : null,
      residual,
      inBalance: residual !== null && Math.abs(residual) < 0.01,
      diagnostics: warnings,
    },

  };
}




export async function buildGeneralLedger(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const accounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr);

  const { data: entries } = await supabase
    .from("journal_entry_lines")
    .select(`
      account_id, debit, credit, description,
      journal_entries!inner(entry_date, entry_number, description, reference, status, organization_id, business_id)
    `)
    .eq("journal_entries.organization_id", organizationId)
    .eq("journal_entries.business_id", requireBusinessId(businessId))
    .eq("journal_entries.status", "posted")
    .gte("journal_entries.entry_date", startStr)
    .lte("journal_entries.entry_date", endStr)
    .order("journal_entries(entry_date)", { ascending: true });

  // Group entries by account
  const entriesByAccount = new Map<string, Array<Record<string, unknown>>>();
  for (const e of ((entries || []) as Record<string, unknown>[])) {
    const accountId = e.account_id as string;
    if (!entriesByAccount.has(accountId)) entriesByAccount.set(accountId, []);
    entriesByAccount.get(accountId)!.push(e);
  }

  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const rows: Record<string, unknown>[] = [];
  let grandDebit = 0;
  let grandCredit = 0;

  // Sort accounts by code
  const sortedAccounts = [...accounts].sort((a, b) => a.code.localeCompare(b.code));

  for (const acct of sortedAccounts) {
    const acctEntries = entriesByAccount.get(acct.id) || [];
    if (acctEntries.length === 0 && acct.opening_balance === 0) continue;

    // Account header row
    rows.push({
      date: "", entry: "",
      description: `${acct.code} - ${acct.name}`,
      debit: null, credit: null, balance: null,
      _isHeader: true,
    });

    // Opening balance row
    rows.push({
      date: "", entry: "",
      description: "Opening Balance",
      debit: null, credit: null,
      balance: acct.opening_balance,
    });

    // Transaction rows with running balance
    let runningBalance = acct.opening_balance;
    const isDebit = isDebitNormal(acct.account_type);
    let totalDebits = 0;
    let totalCredits = 0;

    for (const e of acctEntries) {
      const je = e.journal_entries as Record<string, unknown>;
      const debit = (e.debit as number) || 0;
      const credit = (e.credit as number) || 0;
      totalDebits += debit;
      totalCredits += credit;

      if (isDebit) {
        runningBalance += debit - credit;
      } else {
        runningBalance += credit - debit;
      }

      rows.push({
        date: (je.entry_date as string) || "",
        entry: (je.entry_number as string) || "",
        description: (e.description as string) || (je.description as string) || "",
        debit: debit || null,
        credit: credit || null,
        balance: runningBalance,
      });
    }

    grandDebit += totalDebits;
    grandCredit += totalCredits;

    // Subtotal row
    rows.push({
      date: "", entry: "",
      description: "Total Movement",
      debit: totalDebits,
      credit: totalCredits,
      balance: runningBalance,
      _isSubtotal: true,
    });
  }

  // Grand total row
  rows.push({
    date: "", entry: "",
    description: "GRAND TOTAL",
    debit: grandDebit, credit: grandCredit, balance: null,
    _isGrandTotal: true, _bold: true,
  });

  return {
    data: rows,
    summary: { totalAccounts: sortedAccounts.length, totalTransactions: (entries || []).length, totalDebits: grandDebit, totalCredits: grandCredit },
  };
}

export async function buildPartnerLedger(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const { data: entries } = await supabase
    .from("journal_entry_lines")
    .select(`
      account_id, debit, credit, description, contact_id,
      contacts(name, type),
      journal_entries!inner(entry_date, entry_number, description, status, organization_id, business_id)
    `)
    .eq("journal_entries.organization_id", organizationId)
    .eq("journal_entries.business_id", requireBusinessId(businessId))
    .eq("journal_entries.status", "posted")
    .gte("journal_entries.entry_date", startStr)
    .lte("journal_entries.entry_date", endStr)
    .not("contact_id", "is", null);

  const data = ((entries || []) as Record<string, unknown>[]).map(e => {
    const je = e.journal_entries as Record<string, unknown>;
    const contact = e.contacts as Record<string, unknown> | null;
    return {
      partner_name: contact?.name || "Unknown",
      partner_type: contact?.type || "",
      entry_date: je.entry_date,
      entry_number: je.entry_number,
      description: (e.description as string) || (je.description as string) || "",
      debit: (e.debit as number) || 0,
      credit: (e.credit as number) || 0,
    };
  });

  const totalDebits = data.reduce((s, d) => s + ((d.debit as number) || 0), 0);
  const totalCredits = data.reduce((s, d) => s + ((d.credit as number) || 0), 0);

  return {
    data,
    summary: { totalPartnerEntries: data.length, totalDebits, totalCredits, netBalance: totalDebits - totalCredits },
  };
}

export async function buildJournalReport(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const { data: entries } = await supabase
    .from("journal_entry_lines")
    .select(`
      debit, credit, description,
      accounts(code, name),
      journal_entries!inner(entry_date, entry_number, description, reference, source_type, status, organization_id, business_id)
    `)
    .eq("journal_entries.organization_id", organizationId)
    .eq("journal_entries.business_id", requireBusinessId(businessId))
    .eq("journal_entries.status", "posted")
    .gte("journal_entries.entry_date", startStr)
    .lte("journal_entries.entry_date", endStr);

  const data = ((entries || []) as Record<string, unknown>[]).map(e => {
    const je = e.journal_entries as Record<string, unknown>;
    const acct = e.accounts as Record<string, unknown> | null;
    return {
      entry_date: je.entry_date,
      entry_number: je.entry_number,
      account_code: acct?.code || "",
      account_name: acct?.name || "",
      description: (e.description as string) || (je.description as string) || "",
      reference: je.reference || "",
      source_type: je.source_type || "",
      debit: (e.debit as number) || 0,
      credit: (e.credit as number) || 0,
    };
  });

  const totalDebits = data.reduce((s, d) => s + ((d.debit as number) || 0), 0);
  const totalCredits = data.reduce((s, d) => s + ((d.credit as number) || 0), 0);

  return {
    data,
    summary: { totalEntries: data.length, totalDebits, totalCredits },
  };
}

export async function buildBudgetVsActual(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string
): Promise<ReportResult> {
  const currentYear = new Date().getFullYear();
  const { data: budgets } = await supabase
    .from("budgets")
    .select("id, name, fiscal_year")
    .eq("organization_id", organizationId)
    .eq("business_id", requireBusinessId(businessId))
    .eq("fiscal_year", currentYear)
    .eq("status", "active")
    .limit(1);

  const budget = (budgets || [])[0] as Record<string, unknown> | undefined;

  if (!budget) {
    return { data: [], summary: { message: "No active budget found for current fiscal year" } };
  }

  const { data: budgetItems } = await supabase
    .from("budget_items")
    .select("account_id, budgeted_amount, period_month, accounts(code, name, account_type)")
    .eq("budget_id", budget.id as string);

  const accounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr, ["income", "expense"]);
  const actualMap = new Map(accounts.map(a => [a.id, a.closing_balance - a.opening_balance]));

  const budgetByAccount = new Map<string, { budgeted: number; accountName: string; accountCode: string; accountType: string }>();
  for (const item of (budgetItems || []) as Record<string, unknown>[]) {
    const accountId = item.account_id as string;
    const acct = item.accounts as Record<string, unknown> | null;
    const existing = budgetByAccount.get(accountId) || {
      budgeted: 0,
      accountName: (acct?.name as string) || "",
      accountCode: (acct?.code as string) || "",
      accountType: (acct?.account_type as string) || "",
    };
    existing.budgeted += (item.budgeted_amount as number) || 0;
    budgetByAccount.set(accountId, existing);
  }

  const data = Array.from(budgetByAccount.entries()).map(([accountId, info]) => {
    const actual = actualMap.get(accountId) || 0;
    const variance = actual - info.budgeted;
    const variancePercent = info.budgeted !== 0 ? (variance / Math.abs(info.budgeted)) * 100 : null;
    return {
      account_code: info.accountCode,
      account_name: info.accountName,
      account_type: info.accountType,
      budgeted: info.budgeted,
      actual,
      variance,
      variance_percent: variancePercent ? Math.round(variancePercent * 100) / 100 : null,
    };
  });

  const totalBudgeted = data.reduce((s, d) => s + ((d.budgeted as number) || 0), 0);
  const totalActual = data.reduce((s, d) => s + ((d.actual as number) || 0), 0);

  return {
    data,
    summary: { budgetName: budget.name, totalBudgeted, totalActual, totalVariance: totalActual - totalBudgeted, accountCount: data.length },
  };
}

export async function buildDepreciationSchedule(
  supabase: SupabaseClient, organizationId: string
): Promise<ReportResult> {
  const { data: assets } = await supabase
    .from("fixed_assets")
    .select(`
      id, name, asset_code, acquisition_date, acquisition_cost,
      salvage_value, useful_life_months, depreciation_method,
      accumulated_depreciation, net_book_value, status,
      asset_categories(name)
    `)
    .eq("organization_id", organizationId)
    .in("status", ["active", "in_use"]);

  const data = ((assets || []) as Record<string, unknown>[]).map(a => {
    const category = a.asset_categories as Record<string, unknown> | null;
    return {
      asset_code: a.asset_code,
      name: a.name,
      category: category?.name || "",
      acquisition_date: a.acquisition_date,
      acquisition_cost: a.acquisition_cost,
      salvage_value: a.salvage_value || 0,
      useful_life_months: a.useful_life_months,
      method: a.depreciation_method,
      accumulated_depreciation: a.accumulated_depreciation || 0,
      net_book_value: a.net_book_value || 0,
    };
  });

  const totalCost = data.reduce((s, d) => s + ((d.acquisition_cost as number) || 0), 0);
  const totalAccumulated = data.reduce((s, d) => s + ((d.accumulated_depreciation as number) || 0), 0);
  const totalNBV = data.reduce((s, d) => s + ((d.net_book_value as number) || 0), 0);

  return {
    data,
    summary: { totalAssets: data.length, totalCost, totalAccumulatedDepreciation: totalAccumulated, totalNetBookValue: totalNBV },
  };
}

export async function buildAuditTrail(
  supabase: SupabaseClient, organizationId: string, startStr: string, endStr: string
): Promise<ReportResult> {
  const { data: logs } = await supabase
    .from("audit_logs")
    .select("action, entity_type, entity_name, entity_id, changes_summary, created_at, user_id")
    .eq("organization_id", organizationId)
    .gte("created_at", startStr)
    .lte("created_at", endStr + "T23:59:59Z")
    .order("created_at", { ascending: false })
    .limit(1000);

  const data = (logs || []) as Record<string, unknown>[];
  const actionCounts = data.reduce((acc: Record<string, number>, l) => {
    const action = (l.action as string) || "unknown";
    acc[action] = (acc[action] || 0) + 1;
    return acc;
  }, {});

  return { data, summary: { totalEntries: data.length, ...actionCounts } };
}
