import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface DefaultAccountMappings {
  // Asset Accounts
  cash_account_id?: string;
  bank_account_id?: string;
  accounts_receivable_id?: string;
  inventory_account_id?: string;
  input_tax_account_id?: string;
  fixed_asset_account_id?: string;
  accumulated_depreciation_account_id?: string;
  
  // Liability Accounts
  accounts_payable_id?: string;
  output_tax_account_id?: string;
  customer_deposits_id?: string;
  
  // Income Accounts
  sales_revenue_id?: string;
  other_income_id?: string;
  
  // Expense Accounts
  cost_of_goods_sold_id?: string;
  operating_expenses_id?: string;
  depreciation_expense_id?: string;
  inventory_adjustment_id?: string;
  
  // Equity Accounts
  retained_earnings_id?: string;
  opening_balance_equity_id?: string;

  // Payment method-specific accounts
  credit_card_clearing_id?: string;
  mobile_money_account_id?: string;
  mpesa_account_id?: string;
}

/** Maps setting_key / mapping_type values to DefaultAccountMappings keys */
const MAPPING_KEY_MAP: Record<string, keyof DefaultAccountMappings> = {
  cash: "cash_account_id",
  bank: "bank_account_id",
  accounts_receivable: "accounts_receivable_id",
  inventory: "inventory_account_id",
  input_tax: "input_tax_account_id",
  fixed_asset: "fixed_asset_account_id",
  accumulated_depreciation: "accumulated_depreciation_account_id",
  accounts_payable: "accounts_payable_id",
  output_tax: "output_tax_account_id",
  customer_deposits: "customer_deposits_id",
  sales_revenue: "sales_revenue_id",
  other_income: "other_income_id",
  cogs: "cost_of_goods_sold_id",
  cost_of_goods_sold: "cost_of_goods_sold_id",
  operating_expenses: "operating_expenses_id",
  depreciation_expense: "depreciation_expense_id",
  inventory_adjustment: "inventory_adjustment_id",
  retained_earnings: "retained_earnings_id",
  opening_balance_equity: "opening_balance_equity_id",
  credit_card_clearing: "credit_card_clearing_id",
  mobile_money: "mobile_money_account_id",
  mpesa: "mpesa_account_id",
};

/**
 * Hook to get default account mappings for GL posting.
 *
 * Source of truth: `default_account_settings`.
 *
 * As of the Intelligent Account Mapping refactor, this hook NEVER auto-saves
 * or guesses mappings. Heuristic discovery now lives exclusively in the
 * `preview-default-mappings` edge function and is committed only after the
 * user confirms via the Preview Dialog (DefaultAccountsConfig).
 *
 * If a mapping is missing here, downstream callers must:
 *   - either surface a clear "configure default accounts" CTA, or
 *   - degrade gracefully (no silent guesses against the GL).
 */
export function useDefaultAccounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data: accounts = {}, isLoading } = useQuery({
    queryKey: ["default-accounts", currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<DefaultAccountMappings> => {
      if (!currentOrg) return {};
      // Single source of truth — no heuristics, no silent auto-save.
      return fetchExplicitSettings(currentOrg.id, currentBusiness?.id);
    },
    enabled: !!currentOrg?.id,
    staleTime: 30 * 1000, // 30 seconds — must reflect recent saves for migration validation
    refetchOnMount: "always" as const,
  });

  /**
   * isReady = loading is complete (accounts may or may not be mapped).
   * Use granular checks below for specific operations.
   */
  const isReady = !isLoading;

  /** All 4 core accounts are mapped */
  const hasRequiredAccounts = () => !!(
    accounts.cash_account_id &&
    accounts.accounts_receivable_id &&
    accounts.accounts_payable_id &&
    accounts.sales_revenue_id
  );

  /** Cash/bank + AR mapped — sufficient for receiving payments */
  const hasPaymentAccounts = () => !!(
    (accounts.cash_account_id || accounts.bank_account_id) &&
    accounts.accounts_receivable_id
  );

  /** AP + cash/bank mapped — sufficient for bill payments */
  const hasBillingAccounts = () => !!(
    accounts.accounts_payable_id &&
    (accounts.cash_account_id || accounts.bank_account_id)
  );

  /** Returns list of missing account names for diagnostics */
  const getMissingAccounts = (requiredKeys: (keyof DefaultAccountMappings)[]) => {
    const labels: Record<string, string> = {
      cash_account_id: "Cash",
      bank_account_id: "Bank",
      accounts_receivable_id: "Accounts Receivable",
      accounts_payable_id: "Accounts Payable",
      sales_revenue_id: "Sales Revenue",
      cost_of_goods_sold_id: "Cost of Goods Sold",
      operating_expenses_id: "Operating Expenses",
      retained_earnings_id: "Retained Earnings",
      input_tax_account_id: "Input Tax (Receivable)",
      output_tax_account_id: "Output Tax (Payable)",
      inventory_account_id: "Inventory",
      customer_deposits_id: "Customer Deposits",
      fixed_asset_account_id: "Fixed Assets",
      accumulated_depreciation_account_id: "Accumulated Depreciation",
      depreciation_expense_id: "Depreciation Expense",
      opening_balance_equity_id: "Opening Balance Equity",
      inventory_adjustment_id: "Inventory Adjustment",
      credit_card_clearing_id: "Credit Card Clearing",
      mobile_money_account_id: "Mobile Money",
      mpesa_account_id: "M-Pesa",
      other_income_id: "Other Income",
    };
    return requiredKeys
      .filter(k => !accounts[k])
      .map(k => labels[k] || k);
  };

  const getInvoiceAccountMappings = () => ({
    receivable_account_id: accounts.accounts_receivable_id || "",
    revenue_account_id: accounts.sales_revenue_id || "",
    tax_liability_account_id: accounts.output_tax_account_id,
  });

  const getBillAccountMappings = () => ({
    payable_account_id: accounts.accounts_payable_id || "",
    expense_account_id: accounts.operating_expenses_id || accounts.cost_of_goods_sold_id || "",
    tax_asset_account_id: accounts.input_tax_account_id,
  });

  /**
   * Returns the GL account to debit based on payment method.
   * Maps: cash → Cash, bank_transfer/check → Bank, credit_card → Card Clearing,
   * mpesa → M-Pesa, mobile_money → Mobile Money. Falls back to bank or cash.
   */
  const getPaymentAccountForMethod = (method?: string): string => {
    switch (method) {
      case "cash":
        return accounts.cash_account_id || accounts.bank_account_id || "";
      case "bank_transfer":
      case "check":
        return accounts.bank_account_id || accounts.cash_account_id || "";
      case "credit_card":
        return accounts.credit_card_clearing_id || accounts.bank_account_id || accounts.cash_account_id || "";
      case "mpesa":
        return accounts.mpesa_account_id || accounts.mobile_money_account_id || accounts.bank_account_id || accounts.cash_account_id || "";
      case "mobile_money":
        return accounts.mobile_money_account_id || accounts.bank_account_id || accounts.cash_account_id || "";
      default:
        return accounts.bank_account_id || accounts.cash_account_id || "";
    }
  };

  const getPaymentAccountMappings = (paymentMethod?: string) => ({
    cash_account_id: getPaymentAccountForMethod(paymentMethod),
    receivable_account_id: accounts.accounts_receivable_id || "",
  });

  /**
   * Returns GL account mappings for expense posting.
   * @param paymentMethod - Settlement method (cash, bank, mobile_money, credit_card, petty_cash, payable, employee_reimbursement)
   * @param overrideExpenseAccountId - Optional: specific expense GL account to debit instead of default operating_expenses
   */
  const getExpenseAccountMappings = (paymentMethod?: string, overrideExpenseAccountId?: string) => ({
    expense_account_id: overrideExpenseAccountId || accounts.operating_expenses_id || "",
    payment_account_id: getExpensePaymentAccount(paymentMethod),
  });

  /**
   * Maps expense payment method to the correct credit-side GL account.
   */
  const getExpensePaymentAccount = (method?: string): string => {
    switch (method) {
      case "cash":
        return accounts.cash_account_id || accounts.bank_account_id || "";
      case "bank":
        return accounts.bank_account_id || accounts.cash_account_id || "";
      case "credit_card":
        return accounts.credit_card_clearing_id || accounts.bank_account_id || accounts.cash_account_id || "";
      case "mobile_money":
        return accounts.mobile_money_account_id || accounts.bank_account_id || accounts.cash_account_id || "";
      case "petty_cash":
        return accounts.cash_account_id || "";
      case "payable":
        return accounts.accounts_payable_id || "";
      case "employee_reimbursement":
        return accounts.accounts_payable_id || "";
      default:
        return accounts.cash_account_id || accounts.bank_account_id || "";
    }
  };

  /**
   * Credit Note GL posting reverses the invoice posting:
   * DR Revenue (subtotal), DR Tax Liability (tax), CR Accounts Receivable (total)
   * For fully paid invoices: CR Customer Deposits instead of CR AR
   */
  const getCreditNoteAccountMappings = () => ({
    receivable_account_id: accounts.accounts_receivable_id || "",
    revenue_account_id: accounts.sales_revenue_id || "",
    tax_liability_account_id: accounts.output_tax_account_id,
    customer_deposits_account_id: accounts.customer_deposits_id || undefined,
  });

  /**
   * Fixed Asset acquisition GL posting:
   * DR Fixed Asset Account, CR Cash/Bank or AP
   */
  const getFixedAssetAccountMappings = (paymentMethod?: string) => ({
    fixed_asset_account_id: accounts.fixed_asset_account_id || "",
    payment_account_id: getExpensePaymentAccount(paymentMethod || "bank"),
    depreciation_expense_id: accounts.depreciation_expense_id || "",
    accumulated_depreciation_account_id: accounts.accumulated_depreciation_account_id || "",
  });

  return {
    accounts,
    isLoading,
    isReady,
    hasRequiredAccounts,
    hasPaymentAccounts,
    hasBillingAccounts,
    getMissingAccounts,
    getInvoiceAccountMappings,
    getBillAccountMappings,
    getPaymentAccountMappings,
    getExpenseAccountMappings,
    getCreditNoteAccountMappings,
    getFixedAssetAccountMappings,
  };
}

// ─── Private fetcher functions ───────────────────────────────────────

async function fetchExplicitSettings(
  orgId: string,
  businessId?: string
): Promise<Partial<DefaultAccountMappings>> {
  const mappings: Partial<DefaultAccountMappings> = {};

  if (!businessId) return mappings;

  try {
    const { data } = await supabase
      .from("default_account_settings")
      .select("setting_key, account_id")
      .eq("organization_id", orgId)
      .eq("business_id", businessId);

    if (!data || data.length === 0) return mappings;

    for (const row of data) {
      const field = MAPPING_KEY_MAP[row.setting_key];
      if (field) {
        (mappings as any)[field] = row.account_id;
      }
    }
  } catch {
    // Table may not exist yet in some environments
  }

  return mappings;
}

