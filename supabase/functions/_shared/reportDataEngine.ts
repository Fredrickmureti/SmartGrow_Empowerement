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
  BS_LIABILITY_ORDER,
  SUB_TYPE_LABELS,
  classifyAccount,
  isDebitNormal,
  type AccountSubType,
} from "./reports/accountingKernel.ts";
import { REPORT_SPECS } from "./reports/columnSpecs.ts";
import type { ReportColumn } from "./reportPdfGenerator.ts";
import {
  baseCurrencyNote,
  fxCells,
  hasForeignCurrency,
  withFxColumns,
  type FxLineInput,
} from "./reports/currencyPresentation.ts";

/** Business base currency — the unit every money column on a ledger uses. */
async function fetchBaseCurrency(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("businesses")
    .select("base_currency")
    .eq("id", businessId)
    .maybeSingle();
  return (data?.base_currency as string | undefined) ?? null;
}

/** Map an RPC ledger row onto the FX presentation contract. */
function toFxLine(row: Record<string, unknown>): FxLineInput {
  return {
    entryCurrency: (row.entry_currency as string) ?? null,
    originalDebit: (row.original_debit as number) ?? null,
    originalCredit: (row.original_credit as number) ?? null,
    exchangeRate: (row.exchange_rate as number) ?? null,
  };
}

const getReportSpec = (key: string) => REPORT_SPECS[key];


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
  /** P&L money cell — matches the profit_and_loss column registry. */
  amount?: number;
  /** Balance Sheet money cell — matches the balance_sheet column registry. */
  balance?: number;
  /** Comparative P&L cells. */
  comparison?: number | null;
  variance?: number | null;
  variance_percent?: number | null;
  /** Canonical semantic line kind consumed by the PDF engine. */
  _kind?: "section" | "subsection" | "detail" | "subtotal" | "major_total" | "calculated_result" | "grand_total" | "spacer";
  /** Legacy flags retained for older renderers; `_kind` is authoritative. */
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
  _depth?: number;
  _bold?: boolean;
}

export type ComparisonMode = "none" | "previous_period" | "previous_year";

export interface ReportResult {
  data: Record<string, unknown>[];
  summary: Record<string, unknown>;
  /**
   * Builder-supplied column override. Ledger documents use it to add the
   * conditional multi-currency supplement; comparative statements use it to
   * add Current / Comparison / Variance; without it the registry spec wins.
   */
  columns?: ReportColumn[];
  /** Resolved comparison window, when a comparative builder ran. */
  comparisonPeriod?: { from: string; to: string; mode: Exclude<ComparisonMode, "none"> };
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
 * Fiscal-year-aware opening position per account.
 *
 * Opening balances are accounting output, so they are computed in SQL by
 * `get_ledger_opening_balances` — the same engine the on-screen reports call.
 * Nominal (income/expense) accounts restart at the fiscal-year boundary and
 * the prior years' result is folded into retained earnings, so the opening
 * columns still balance. Never re-derive this in a runtime.
 */
async function openingBalances(
  supabase: SupabaseClient,
  organizationId: string,
  businessId: string,
  asOf: string,
  branchId?: string,
): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc("get_ledger_opening_balances", {
    _org_id: organizationId,
    _business_id: businessId,
    _as_of: asOf,
    _branch_id: branchId ?? null,
  });
  if (error) throw new Error(`Failed to fetch opening balances: ${error.message}`);
  const map = new Map<string, number>();
  for (const row of (data || []) as Record<string, unknown>[]) {
    map.set(row.account_id as string, Number(row.opening_balance) || 0);
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

  // Deactivated accounts are INCLUDED. Deactivation is a chart-of-accounts
  // hygiene action, not a settlement: a closed bank account or retired loan
  // still carries a position the entity owns or owes, and dropping those rows
  // here while the equity/result RPCs still counted their movement is how a
  // balance sheet stops balancing. Zero rows are suppressed downstream
  // (`closing_balance === 0`), so an inactive-and-empty account still never
  // reaches the page — same rule the screens apply.
  let accountsQuery = supabase
    .from("accounts")
    .select("id, code, name, account_type, detail_type, parent_id, opening_balance, is_active")
    .eq("organization_id", organizationId)
    .eq("business_id", scopedBusinessId)
    .order("code");


  if (accountTypeFilter && accountTypeFilter.length > 0) {
    accountsQuery = accountsQuery.in("account_type", accountTypeFilter);
  }

  const { data: accounts, error: accountsError } = await accountsQuery;
  if (accountsError) throw new Error(`Failed to fetch accounts: ${accountsError.message}`);

  const [periodByAccount, openingByAccount] = await Promise.all([
    accountMovements(supabase, organizationId, scopedBusinessId, startStr, endStr, branchId),
    openingBalances(supabase, organizationId, scopedBusinessId, startStr, branchId),
  ]);

  const result: AccountWithBalance[] = [];
  for (const account of (accounts || []) as Record<string, unknown>[]) {
    const id = account.id as string;
    const accountType = account.account_type as string;
    const period = periodByAccount.get(id) || { debit: 0, credit: 0 };
    // Server-owned: fiscal-year reset for nominal accounts, retained-earnings
    // absorption of prior years, and branch suppression of the business-level
    // `accounts.opening_balance` all live in the RPC.
    const openingBalance = openingByAccount.get(id) ?? 0;

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
  // Single retained-earnings authority, shared with the on-screen statement:
  // SQL owns the fiscal calendar, this year's result and the closed years'
  // result (which it folds into the retained-earnings account's opening
  // balance). Deriving it here from income/expense totals would let the PDF
  // and the screen disagree.
  //
  // Resolved BEFORE the balances, because it also decides the reporting
  // window: `get_ledger_opening_balances` only performs the retained-earnings
  // fold when the requested date precedes the fiscal-year start. A window
  // starting inside the current fiscal year therefore returns a
  // retained-earnings account with no closed-year result in it, and the
  // exported statement silently loses every prior year's profit — the same
  // defect the on-screen statement had. Anchoring the window to the
  // fiscal-year start makes the fold happen, and the balance stays an
  // as-of-`endStr` figure either way, since
  // opening(fy_start) + movement(fy_start..endStr) == balance(endStr).
  const { data: equityRows, error: equityError } = await supabase.rpc("get_equity_result", {
    _org_id: organizationId,
    _business_id: requireBusinessId(businessId),
    _as_of: endStr,
    _branch_id: null,
  });
  if (equityError) throw new Error(`Failed to resolve equity result: ${equityError.message}`);
  const equity = (Array.isArray(equityRows) ? equityRows[0] : equityRows) as
    | {
        fiscal_year_start?: string | null;
        current_year_earnings?: number;
        prior_years_result?: number;
        retained_earnings_account_id?: string | null;
      }
    | undefined;
  const retainedEarnings = Number(equity?.current_year_earnings ?? 0);
  const priorYearsResult = Number(equity?.prior_years_result ?? 0);
  const hasRetainedEarningsAccount = Boolean(equity?.retained_earnings_account_id);
  // With no retained-earnings account there is nowhere for SQL to fold the
  // closed years' result, so it has to be presented as its own equity line or
  // the statement cannot balance.
  const unfoldedPriorYears = hasRetainedEarningsAccount ? 0 : priorYearsResult;

  const effectiveStart = equity?.fiscal_year_start ?? startStr;
  const accounts = await getGLAccountBalances(
    supabase, organizationId, businessId, effectiveStart, endStr, ["asset", "liability", "equity"],
  );

  const classified = accounts.map(a => ({
    ...a,
    sub_type: classifyAccountSubType(a.account_type, a.code, a.detail_type),
  }));

  const rows: ClassifiedRow[] = [];

  // Equity carries two derived additions: this year's result, and — only when
  // there is no retained-earnings account to absorb it — the closed years'
  // result. Both are added once.
  const equityAddition = retainedEarnings + unfoldedPriorYears;

  const totalFor = (accountType: string) =>
    classified
      .filter(a => a.account_type === accountType)
      .reduce((s, a) => s + a.closing_balance, 0);

  const buildClassifiedSection = (
    sectionLabel: string,
    accountType: "asset" | "liability",
    subTypeOrder: AccountSubType[],
    totalKind: "grand_total" | "major_total",
  ) => {
    const sectionAccounts = classified.filter(a => a.account_type === accountType);
    const sectionTotal = sectionAccounts.reduce((s, a) => s + a.closing_balance, 0);

    rows.push({ name: sectionLabel.toUpperCase(), _kind: "section", _isHeader: true, _bold: true });

    for (const subType of subTypeOrder) {
      const group = sectionAccounts.filter(a => a.sub_type === subType);
      if (group.length === 0) continue;

      rows.push({ name: SUB_TYPE_LABELS[subType], _kind: "subsection", _isHeader: true, _depth: 1 });

      for (const acct of group) {
        if (acct.closing_balance === 0) continue;
        rows.push({ name: acct.name, code: acct.code, balance: acct.closing_balance, _kind: "detail", _depth: 2 });
      }

      const subTotal = group.reduce((s, a) => s + a.closing_balance, 0);
      rows.push({ name: `Total ${SUB_TYPE_LABELS[subType]}`, balance: subTotal, _kind: "subtotal", _isSubtotal: true, _depth: 1 });
    }

    rows.push({
      name: `Total ${sectionLabel}`,
      balance: sectionTotal,
      _kind: totalKind,
      _isGrandTotal: totalKind === "grand_total",
      _bold: true,
    });
  };

  buildClassifiedSection("Assets", "asset", BS_ASSET_ORDER, "grand_total");
  buildClassifiedSection("Liabilities", "liability", BS_LIABILITY_ORDER, "major_total");

  // Equity presentation matches the screen exactly: one flat section, the
  // current-year result, the no-retained-account safety line, then the final
  // liabilities-plus-equity balancing total.
  rows.push({ name: "EQUITY", _kind: "section", _isHeader: true, _bold: true });
  const equityAccounts = classified.filter(a => a.account_type === "equity");
  for (const acct of equityAccounts) {
    if (acct.closing_balance === 0) continue;
    rows.push({ name: acct.name, code: acct.code, balance: acct.closing_balance, _kind: "detail", _depth: 2 });
  }
  if (retainedEarnings !== 0) {
    rows.push({ name: "Current Year Earnings", balance: retainedEarnings, _kind: "detail", _depth: 2 });
  }
  if (unfoldedPriorYears !== 0) {
    rows.push({
      name: "Prior years' result (unallocated — no retained earnings account)",
      balance: unfoldedPriorYears,
      _kind: "detail",
      _depth: 2,
    });
  }

  const totalAssets = totalFor("asset");
  const totalLiabilities = totalFor("liability");
  const totalEquity = totalFor("equity") + equityAddition;

  rows.push({ name: "Total Equity", balance: totalEquity, _kind: "major_total", _bold: true });
  rows.push({
    name: "Total Liabilities and Equity",
    balance: totalLiabilities + totalEquity,
    _kind: "grand_total",
    _isGrandTotal: true,
    _bold: true,
  });

  return {
    data: rows as unknown as Record<string, unknown>[],
    summary: {
      totalAssets,
      totalLiabilities,
      totalEquity,
      retainedEarnings,
      priorYearsResult,
      fiscalYearStart: equity?.fiscal_year_start ?? null,
      hasRetainedEarningsAccount,
      netAssets: totalAssets - totalLiabilities - totalEquity,
    },
  };
}


export async function buildTrialBalance(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string,
  branchId?: string,
): Promise<ReportResult> {
  const accounts = await getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr, undefined, branchId);


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

// ── Comparative period resolution ─────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDateUTC(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid report date: ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatIsoDateUTC(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDateYears(value: string, years: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const targetYear = year + years;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return formatIsoDateUTC(new Date(Date.UTC(targetYear, month - 1, Math.min(day, daysInTargetMonth))));
}

/**
 * Resolve the comparison window once for UI, on-demand export and schedules.
 * Previous period is the immediately preceding window of equal inclusive
 * length; previous year is the same dates shifted one calendar year.
 */
export function resolveComparisonPeriod(
  mode: ComparisonMode | null | undefined,
  startStr: string,
  endStr: string,
): { from: string; to: string; mode: Exclude<ComparisonMode, "none"> } | null {
  if (!mode || mode === "none") return null;
  if (mode === "previous_year") {
    return { mode, from: shiftIsoDateYears(startStr, -1), to: shiftIsoDateYears(endStr, -1) };
  }

  const start = parseIsoDateUTC(startStr);
  const end = parseIsoDateUTC(endStr);
  const inclusiveDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const comparisonEnd = new Date(start.getTime() - DAY_MS);
  const comparisonStart = new Date(comparisonEnd.getTime() - ((inclusiveDays - 1) * DAY_MS));
  return {
    mode,
    from: formatIsoDateUTC(comparisonStart),
    to: formatIsoDateUTC(comparisonEnd),
  };
}

/** Percentage variance with a truthful empty cell for a zero comparison base. */
function variancePercent(variance: number, comparison: number): number | null {
  return comparison !== 0 ? (variance / Math.abs(comparison)) * 100 : null;
}

function comparisonCell(current: number, comparison: number) {
  const variance = current - comparison;
  return {
    amount: current,
    comparison,
    variance,
    variance_percent: variancePercent(variance, comparison),
  };
}

/**
 * Profit & Loss — multi-step, identical in structure to the on-screen
 * statement (`useFinancialReport` + `FinancialReports.tsx`):
 *
 *   Revenue − Cost of sales = Gross profit
 *   Gross profit − Operating expenses = Operating profit
 *   Operating profit + Other income − Other expenses = Profit before tax
 *   Profit before tax − Tax = Net profit
 *
 * Exactly one grand total (net profit); the intermediate results are
 * calculated subtotals. Branch is a legitimate P&L dimension (performance,
 * not position), so `branchId` is threaded through to the ledger RPCs — a
 * branch-scoped scheduled P&L used to silently return whole-business figures.
 */
export async function buildIncomeStatement(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string,
  branchId?: string,
): Promise<ReportResult> {
  const accounts = await getGLAccountBalances(
    supabase, organizationId, businessId, startStr, endStr, ["income", "expense"], branchId,
  );
  const classified = accounts.map(a => ({
    ...a,
    sub_type: classifyAccountSubType(a.account_type, a.code, a.detail_type),
    balance: a.closing_balance - a.opening_balance,
  }));

  const rows: ClassifiedRow[] = [];

  /** Renders one sub-type group and returns its total (0 when absent). */
  const section = (
    subType: AccountSubType,
    accountType: "income" | "expense",
    heading: string,
  ): number => {
    const group = classified.filter(a => a.sub_type === subType && a.account_type === accountType);
    if (group.length === 0) return 0;
    const total = group.reduce((s, a) => s + a.balance, 0);
    rows.push({ name: heading.toUpperCase(), _kind: "section", _isHeader: true, _bold: true });
    for (const acct of group) {
      if (acct.balance === 0) continue;
      rows.push({ name: acct.name, code: acct.code, amount: acct.balance, _kind: "detail", _depth: 1 });
    }
    rows.push({ name: `Total ${heading}`, amount: total, _kind: "subtotal", _isSubtotal: true, _depth: 0 });
    return total;
  };

  const revenue = section("revenue", "income", "Revenue");
  const costOfSales = section("cost_of_sales", "expense", "Cost of Sales");
  const grossProfit = revenue - costOfSales;
  rows.push({ name: "GROSS PROFIT", amount: grossProfit, _kind: "calculated_result", _isSubtotal: true, _bold: true });

  const operatingExpenses = section("operating_expense", "expense", "Operating Expenses");
  const operatingProfit = grossProfit - operatingExpenses;
  rows.push({ name: "OPERATING PROFIT", amount: operatingProfit, _kind: "calculated_result", _isSubtotal: true, _bold: true });

  const otherIncome = section("other_income", "income", "Other Income");
  const otherExpenses = section("other_expense", "expense", "Other Expenses");
  const profitBeforeTax = operatingProfit + otherIncome - otherExpenses;
  rows.push({ name: "PROFIT BEFORE TAX", amount: profitBeforeTax, _kind: "calculated_result", _isSubtotal: true, _bold: true });

  const taxExpense = section("tax_expense", "expense", "Tax Expense");
  const netIncome = profitBeforeTax - taxExpense;
  rows.push({ name: "NET PROFIT", amount: netIncome, _kind: "grand_total", _isGrandTotal: true, _bold: true });

  const totalIncome = revenue + otherIncome;
  const totalExpenses = operatingExpenses + otherExpenses + taxExpense;

  return {
    data: rows as unknown as Record<string, unknown>[],
    summary: {
      totalRevenue: revenue,
      totalIncome,
      totalCOGS: costOfSales,
      grossProfit,
      operatingExpenses,
      operatingProfit,
      otherIncome,
      otherExpenses,
      profitBeforeTax,
      taxExpense,
      totalExpenses,
      netIncome,
    },
  };
}

/**
 * Comparative Profit & Loss for scheduled/server-built exports. This is the
 * same multi-step presentation as the screen's comparison mode: every detail,
 * subtotal and calculated result carries all four money columns, so the
 * statement foots horizontally as well as vertically.
 */
export async function buildComparativeIncomeStatement(
  supabase: SupabaseClient,
  organizationId: string,
  businessId: string | undefined,
  startStr: string,
  endStr: string,
  branchId?: string,
  mode: Exclude<ComparisonMode, "none"> = "previous_year",
): Promise<ReportResult> {
  const comparisonPeriod = resolveComparisonPeriod(mode, startStr, endStr);
  if (!comparisonPeriod) throw new Error(`Unsupported comparison mode: ${mode}`);

  const [currentAccounts, comparisonAccounts] = await Promise.all([
    getGLAccountBalances(supabase, organizationId, businessId, startStr, endStr, ["income", "expense"], branchId),
    getGLAccountBalances(
      supabase,
      organizationId,
      businessId,
      comparisonPeriod.from,
      comparisonPeriod.to,
      ["income", "expense"],
      branchId,
    ),
  ]);

  interface ComparativeAccount extends AccountWithBalance {
    sub_type: AccountSubType;
    balance: number;
  }

  const classify = (accounts: AccountWithBalance[]): ComparativeAccount[] =>
    accounts.map(a => ({
      ...a,
      sub_type: classifyAccountSubType(a.account_type, a.code, a.detail_type),
      balance: a.closing_balance - a.opening_balance,
    }));

  const currentClassified = classify(currentAccounts);
  const comparisonClassified = classify(comparisonAccounts);
  const currentById = new Map(currentClassified.map(a => [a.id, a]));
  const comparisonById = new Map(comparisonClassified.map(a => [a.id, a]));

  // One row per account. Current-period classification wins when an account's
  // type/detail changed; comparison-only accounts still appear so the
  // comparison column foots instead of silently dropping closed accounts.
  const orderedAccounts: ComparativeAccount[] = [...currentClassified];
  for (const account of comparisonClassified) {
    if (!currentById.has(account.id)) orderedAccounts.push(account);
  }

  const rows: ClassifiedRow[] = [];

  const section = (
    subType: AccountSubType,
    accountType: "income" | "expense",
    heading: string,
  ): { current: number; comparison: number } => {
    const group = orderedAccounts.filter(a => a.sub_type === subType && a.account_type === accountType);
    if (group.length === 0) return { current: 0, comparison: 0 };

    let currentTotal = 0;
    let comparisonTotal = 0;
    rows.push({ name: heading.toUpperCase(), _kind: "section", _isHeader: true, _bold: true });

    for (const account of group) {
      const current = currentById.get(account.id)?.balance ?? 0;
      const comparison = comparisonById.get(account.id)?.balance ?? 0;
      if (current === 0 && comparison === 0) continue;
      currentTotal += current;
      comparisonTotal += comparison;
      rows.push({
        name: account.name,
        code: account.code,
        ...comparisonCell(current, comparison),
        _kind: "detail",
        _depth: 1,
      });
    }

    rows.push({
      name: `Total ${heading}`,
      ...comparisonCell(currentTotal, comparisonTotal),
      _kind: "subtotal",
      _isSubtotal: true,
      _depth: 0,
    });
    return { current: currentTotal, comparison: comparisonTotal };
  };

  const revenue = section("revenue", "income", "Revenue");
  const costOfSales = section("cost_of_sales", "expense", "Cost of Sales");
  const grossProfit = {
    current: revenue.current - costOfSales.current,
    comparison: revenue.comparison - costOfSales.comparison,
  };
  rows.push({
    name: "GROSS PROFIT",
    ...comparisonCell(grossProfit.current, grossProfit.comparison),
    _kind: "calculated_result",
    _isSubtotal: true,
    _bold: true,
  });

  const operatingExpenses = section("operating_expense", "expense", "Operating Expenses");
  const operatingProfit = {
    current: grossProfit.current - operatingExpenses.current,
    comparison: grossProfit.comparison - operatingExpenses.comparison,
  };
  rows.push({
    name: "OPERATING PROFIT",
    ...comparisonCell(operatingProfit.current, operatingProfit.comparison),
    _kind: "calculated_result",
    _isSubtotal: true,
    _bold: true,
  });

  const otherIncome = section("other_income", "income", "Other Income");
  const otherExpenses = section("other_expense", "expense", "Other Expenses");
  const profitBeforeTax = {
    current: operatingProfit.current + otherIncome.current - otherExpenses.current,
    comparison: operatingProfit.comparison + otherIncome.comparison - otherExpenses.comparison,
  };
  rows.push({
    name: "PROFIT BEFORE TAX",
    ...comparisonCell(profitBeforeTax.current, profitBeforeTax.comparison),
    _kind: "calculated_result",
    _isSubtotal: true,
    _bold: true,
  });

  const taxExpense = section("tax_expense", "expense", "Tax Expense");
  const netIncome = {
    current: profitBeforeTax.current - taxExpense.current,
    comparison: profitBeforeTax.comparison - taxExpense.comparison,
  };
  rows.push({
    name: "NET PROFIT",
    ...comparisonCell(netIncome.current, netIncome.comparison),
    _kind: "grand_total",
    _isGrandTotal: true,
    _bold: true,
  });

  return {
    data: rows as unknown as Record<string, unknown>[],
    columns: [
      { key: "name", header: "Account", width: 40, align: "left", format: "text" },
      { key: "amount", header: "Current", width: 15, align: "right", format: "currency" },
      { key: "comparison", header: "Comparison", width: 15, align: "right", format: "currency" },
      { key: "variance", header: "Variance", width: 15, align: "right", format: "currency" },
      { key: "variance_percent", header: "Var %", width: 15, align: "right", format: "percent" },
    ],
    comparisonPeriod,
    summary: {
      totalRevenue: revenue.current,
      totalCOGS: costOfSales.current,
      grossProfit: grossProfit.current,
      operatingExpenses: operatingExpenses.current,
      operatingProfit: operatingProfit.current,
      otherIncome: otherIncome.current,
      otherExpenses: otherExpenses.current,
      profitBeforeTax: profitBeforeTax.current,
      taxExpense: taxExpense.current,
      netIncome: netIncome.current,
      comparisonRevenue: revenue.comparison,
      comparisonNetIncome: netIncome.comparison,
      netIncomeVariance: netIncome.current - netIncome.comparison,
      comparisonFrom: comparisonPeriod.from,
      comparisonTo: comparisonPeriod.to,
    },
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




/**
 * General Ledger — built from the SAME `get_general_ledger` RPC the screen
 * uses, so the scheduled PDF and the on-screen register are one document.
 * The previous implementation re-derived opening balances and movements from
 * raw `journal_entry_lines` (capped at 1000 rows, branch-blind, `posted`-only).
 */
export async function buildGeneralLedger(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string,
  branchId?: string,
): Promise<ReportResult> {
  const { data: glRows, error } = await supabase.rpc("get_general_ledger", {
    _org_id: organizationId,
    _date_from: startStr,
    _date_to: endStr,
    _business_id: requireBusinessId(businessId),
    _account_ids: null,
    _include_zero_activity: false,
    _branch_id: branchId ?? null,
  });
  if (error) throw new Error(`Failed to build general ledger: ${error.message}`);

  interface GLAccount {
    code: string;
    name: string;
    accountType: string;
    openingBalance: number;
    lines: Record<string, unknown>[];
  }

  const byAccount = new Map<string, GLAccount>();
  for (const raw of (glRows || []) as Record<string, unknown>[]) {
    const accountId = raw.account_id as string;
    let acct = byAccount.get(accountId);
    if (!acct) {
      acct = {
        code: raw.account_code as string,
        name: raw.account_name as string,
        accountType: raw.account_type as string,
        openingBalance: Number(raw.opening_balance) || 0,
        lines: [],
      };
      byAccount.set(accountId, acct);
    }
    if (raw.line_id) acct.lines.push(raw);
  }

  const rows: Record<string, unknown>[] = [];
  let grandDebit = 0;
  let grandCredit = 0;
  let lineCount = 0;

  // Base currency is the unit every money column is expressed in; the FX
  // supplement only appears when the run actually contains a foreign line.
  const baseCurrency = await fetchBaseCurrency(supabase, requireBusinessId(businessId));
  const allLines = [...byAccount.values()].flatMap((a) => a.lines);
  const showFx = hasForeignCurrency(
    allLines.map((l) => toFxLine(l)),
    baseCurrency,
  );

  const sortedAccounts = [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));

  for (const acct of sortedAccounts) {
    rows.push({
      date: "", entry: "",
      description: `${acct.code} - ${acct.name}`,
      debit: null, credit: null, balance: null,
      _isHeader: true,
    });

    rows.push({
      date: "", entry: "",
      description: "Opening Balance",
      debit: null, credit: null,
      balance: acct.openingBalance,
    });

    let runningBalance = acct.openingBalance;
    const isDebit = isDebitNormal(acct.accountType);
    let totalDebits = 0;
    let totalCredits = 0;

    for (const line of acct.lines) {
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      totalDebits += debit;
      totalCredits += credit;
      lineCount += 1;

      runningBalance += isDebit ? debit - credit : credit - debit;

      // A reversed original stays in the ledger next to its reversal; the
      // printed document has to say which line is which.
      const status = line.is_reversal
        ? `Reversal${line.reversal_of_number ? ` of ${line.reversal_of_number}` : ""}`
        : line.entry_status === "reversed"
          ? "Reversed"
          : "";

      rows.push({
        date: (line.entry_date as string) || "",
        entry: (line.entry_number as string) || "",
        description: (line.line_description as string) || (line.je_description as string) || "",
        journal: (line.journal_book as string) || "",
        branch: (line.branch_name as string) || "",
        status,
        ...(showFx ? fxCells(toFxLine(line), baseCurrency) : {}),
        debit: debit || null,
        credit: credit || null,
        balance: runningBalance,
      });
    }

    grandDebit += totalDebits;
    grandCredit += totalCredits;

    rows.push({
      date: "", entry: "",
      description: "Total Movement",
      debit: totalDebits,
      credit: totalCredits,
      balance: runningBalance,
      _isSubtotal: true,
    });
  }

  // The grand total proves debits = credits across the run; a summed balance
  // there nets to nil, so it stays empty unless the run is a single account.
  rows.push({
    date: "", entry: "",
    description: "GRAND TOTAL",
    debit: grandDebit, credit: grandCredit, balance: null,
    _isGrandTotal: true, _bold: true,
  });

  const spec = getReportSpec("general_ledger");
  return {
    data: rows,
    summary: {
      totalAccounts: sortedAccounts.length,
      totalTransactions: lineCount,
      totalDebits: grandDebit,
      totalCredits: grandCredit,
      baseCurrency,
      note: baseCurrencyNote(baseCurrency),
    },
    ...(showFx && spec ? { columns: withFxColumns(spec.columns) } : {}),
  };
}



/**
 * Partner Ledger (AR + AP) — built from `finance_partner_ledger`, the SAME
 * SQL engine the screen reads.
 *
 * It previously paged `journal_entry_lines` here with its own posted-only
 * filter, no branch scoping and PostgREST's 1000-row cap, which is a second
 * implementation of a sub-ledger that is already server-owned. Opening,
 * running and closing balances are accounting output: they are computed in
 * SQL and consumed verbatim.
 */
export async function buildPartnerLedger(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string,
  branchId?: string,
): Promise<ReportResult> {
  const businessScoped = requireBusinessId(businessId);
  const data: Record<string, unknown>[] = [];
  let totalDebits = 0;
  let totalCredits = 0;

  for (const side of ["customer", "supplier"] as const) {
    const { data: payload, error } = await supabase.rpc("finance_partner_ledger", {
      _org_id: organizationId,
      _business_id: businessScoped,
      _branch_id: branchId ?? null,
      _side: side,
      _from: startStr,
      _to: endStr,
      _contact_id: null,
      _search: null,
      _limit: null,
      _offset: 0,
    });
    if (error) throw error;

    const partners = ((payload as Record<string, unknown> | null)?.partners ?? []) as Record<string, unknown>[];
    const partnerType = side === "customer" ? "Customer" : "Supplier";

    for (const partner of partners) {
      const txns = (partner.transactions ?? []) as Record<string, unknown>[];
      for (const t of txns) {
        const debit = Number(t.debit) || 0;
        const credit = Number(t.credit) || 0;
        totalDebits += debit;
        totalCredits += credit;
        data.push({
          partner_name: partner.contact_name ?? "Unknown",
          partner_type: partnerType,
          entry_date: t.entry_date,
          entry_number: t.entry_number,
          description: t.description ?? "",
          debit,
          credit,
        });
      }
    }
  }

  data.sort((a, b) => String(a.entry_date ?? "").localeCompare(String(b.entry_date ?? "")));

  return {
    data,
    summary: { totalPartnerEntries: data.length, totalDebits, totalCredits, netBalance: totalDebits - totalCredits },
  };
}


/**
 * Journal Report (posting journal) — entry-centric, grouped, balanced.
 *
 * Built from the `get_journal_report` RPC, the same engine as the screen, so
 * the scheduled PDF is the same document the user reads. Pages through the
 * RPC rather than truncating at PostgREST's 1000-row cap.
 */
export async function buildJournalReport(
  supabase: SupabaseClient, organizationId: string, businessId: string | undefined, startStr: string, endStr: string,
  branchId?: string,
): Promise<ReportResult> {
  const scopedBusinessId = requireBusinessId(businessId);
  const PAGE = 500;

  interface JREntry {
    entryDate: string;
    entryNumber: string;
    description: string;
    sourceType: string;
    status: string | null;
    isReversal: boolean;
    reversalOfNumber: string | null;
    journalBook: string | null;
    branchName: string | null;
    totalDebit: number;
    totalCredit: number;
    lines: {
      accountCode: string; accountName: string; description: string;
      debit: number; credit: number; fx: FxLineInput;
    }[];
  }

  const entries = new Map<string, JREntry>();
  const order: string[] = [];

  for (let page = 0; ; page += 1) {
    const { data: rows, error } = await supabase.rpc("get_journal_report", {
      _org_id: organizationId,
      _date_from: startStr,
      _date_to: endStr,
      _business_id: scopedBusinessId,
      _branch_id: branchId ?? null,
      _source_types: null,
      _limit: PAGE,
      _offset: page * PAGE,
    });
    if (error) throw new Error(`Failed to build journal report: ${error.message}`);

    const list = (rows || []) as Record<string, unknown>[];
    for (const r of list) {
      const id = r.entry_id as string;
      let je = entries.get(id);
      if (!je) {
        je = {
          entryDate: r.entry_date as string,
          entryNumber: (r.entry_number as string) || "",
          description: (r.je_description as string) || "",
          sourceType: (r.source_type as string) || "manual",
          status: (r.entry_status as string) || null,
          isReversal: Boolean(r.is_reversal),
          reversalOfNumber: (r.reversal_of_number as string) || null,
          journalBook: (r.journal_book as string) || null,
          branchName: (r.branch_name as string) || null,
          totalDebit: 0,
          totalCredit: 0,
          lines: [],
        };
        entries.set(id, je);
        order.push(id);
      }
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      je.totalDebit += debit;
      je.totalCredit += credit;
      je.lines.push({
        accountCode: (r.account_code as string) || "",
        accountName: (r.account_name as string) || "",
        description: (r.line_description as string) || je.description,
        debit,
        credit,
        fx: toFxLine({ ...r, entry_currency: r.entry_currency ?? r.currency }),
      });
    }

    const totalEntries = Number((list[0]?.total_entries as number) ?? 0);
    if (list.length === 0 || entries.size >= totalEntries) break;
  }

  // Base currency governs every money column; the FX supplement appears only
  // when the period actually contains a foreign-currency line.
  const baseCurrency = await fetchBaseCurrency(supabase, scopedBusinessId);
  const showFx = hasForeignCurrency(
    [...entries.values()].flatMap((e) => e.lines.map((l) => l.fx)),
    baseCurrency,
  );

  const rows: Record<string, unknown>[] = [];
  let totalDebits = 0;
  let totalCredits = 0;

  for (const id of order) {
    const je = entries.get(id)!;
    const marker = je.isReversal
      ? ` · Reversal${je.reversalOfNumber ? ` of ${je.reversalOfNumber}` : ""}`
      : je.status === "reversed"
        ? " · Reversed"
        : "";
    const book = je.journalBook ? ` · ${je.journalBook}` : "";
    const branch = je.branchName ? ` · ${je.branchName}` : "";

    rows.push({
      account: `${je.entryDate} · ${je.entryNumber}${book}${branch}${marker} — ${je.description}`,
      description: "", source: "", debit: null, credit: null,
      _isHeader: true,
    });

    for (const line of je.lines) {
      rows.push({
        account: `${line.accountCode} - ${line.accountName}`,
        description: line.description,
        source: je.sourceType,
        ...(showFx ? fxCells(line.fx, baseCurrency) : {}),
        debit: line.debit || null,
        credit: line.credit || null,
      });
    }

    totalDebits += je.totalDebit;
    totalCredits += je.totalCredit;

    rows.push({
      account: "Entry total", description: "", source: "",
      debit: je.totalDebit, credit: je.totalCredit,
      _isSubtotal: true,
    });
  }

  if (rows.length > 0) {
    rows.push({
      account: "TOTAL POSTED", description: "", source: "",
      debit: totalDebits, credit: totalCredits,
      _isGrandTotal: true, _bold: true,
    });
  }

  const spec = getReportSpec("journal_report");
  return {
    data: rows,
    summary: {
      totalEntries: entries.size,
      totalDebits,
      totalCredits,
      baseCurrency,
      note: baseCurrencyNote(baseCurrency),
    },
    ...(showFx && spec ? { columns: withFxColumns(spec.columns) } : {}),
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
