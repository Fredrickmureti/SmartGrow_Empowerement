import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * Institution-level GL defaults for Smart Grow Empowerment.
 *
 * Scope is deliberately narrow: treasury, payables, tax, operating expense,
 * equity and fixed-asset roles. Lending GL mappings (loan receivable, interest
 * income, fee/penalty income, disbursement clearing, write-off expense) are NOT
 * here — they are owned server-side by `mf_resolve_account` and configured under
 * Lending → Configuration → Accounting.
 *
 * Source of truth: `default_account_settings`. No heuristics, no auto-save.
 */
export interface DefaultAccountMappings {
  // Assets
  cash_account_id?: string;
  bank_account_id?: string;
  input_tax_account_id?: string;
  fixed_asset_account_id?: string;
  accumulated_depreciation_account_id?: string;

  // Liabilities
  accounts_payable_id?: string;
  output_tax_account_id?: string;

  // Income
  other_income_id?: string;

  // Expenses
  operating_expenses_id?: string;
  depreciation_expense_id?: string;

  // Equity
  retained_earnings_id?: string;
  opening_balance_equity_id?: string;

  // Settlement channels
  mobile_money_account_id?: string;
  mpesa_account_id?: string;
}

/** Maps `default_account_settings.setting_key` → DefaultAccountMappings keys */
const MAPPING_KEY_MAP: Record<string, keyof DefaultAccountMappings> = {
  cash: "cash_account_id",
  bank: "bank_account_id",
  input_tax: "input_tax_account_id",
  fixed_asset: "fixed_asset_account_id",
  accumulated_depreciation: "accumulated_depreciation_account_id",
  accounts_payable: "accounts_payable_id",
  output_tax: "output_tax_account_id",
  other_income: "other_income_id",
  operating_expenses: "operating_expenses_id",
  depreciation_expense: "depreciation_expense_id",
  retained_earnings: "retained_earnings_id",
  opening_balance_equity: "opening_balance_equity_id",
  mobile_money: "mobile_money_account_id",
  mpesa: "mpesa_account_id",
};

const ACCOUNT_LABELS: Record<keyof DefaultAccountMappings, string> = {
  cash_account_id: "Cash",
  bank_account_id: "Bank",
  input_tax_account_id: "Input Tax (Receivable)",
  fixed_asset_account_id: "Fixed Assets",
  accumulated_depreciation_account_id: "Accumulated Depreciation",
  accounts_payable_id: "Accounts Payable",
  output_tax_account_id: "Output Tax (Payable)",
  other_income_id: "Other Income",
  operating_expenses_id: "Operating Expenses",
  depreciation_expense_id: "Depreciation Expense",
  retained_earnings_id: "Retained Earnings",
  opening_balance_equity_id: "Opening Balance Equity",
  mobile_money_account_id: "Mobile Money",
  mpesa_account_id: "M-Pesa",
};

export function useDefaultAccounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data: accounts = {}, isLoading } = useQuery({
    queryKey: ["default-accounts", currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<DefaultAccountMappings> => {
      if (!currentOrg) return {};
      return fetchExplicitSettings(currentOrg.id, currentBusiness?.id);
    },
    enabled: !!currentOrg?.id,
    staleTime: 30 * 1000,
    refetchOnMount: "always" as const,
  });

  const isReady = !isLoading;

  /** Returns list of missing account names for diagnostics */
  const getMissingAccounts = (requiredKeys: (keyof DefaultAccountMappings)[]) =>
    requiredKeys.filter((k) => !accounts[k]).map((k) => ACCOUNT_LABELS[k] || k);

  /** Credit-side settlement account for institutional money-out. */
  const getSettlementAccount = (method?: string): string => {
    switch (method) {
      case "cash":
      case "petty_cash":
        return accounts.cash_account_id || accounts.bank_account_id || "";
      case "bank":
      case "bank_transfer":
      case "check":
        return accounts.bank_account_id || accounts.cash_account_id || "";
      case "mpesa":
        return accounts.mpesa_account_id || accounts.mobile_money_account_id || accounts.bank_account_id || "";
      case "mobile_money":
        return accounts.mobile_money_account_id || accounts.bank_account_id || accounts.cash_account_id || "";
      case "payable":
      case "employee_reimbursement":
        return accounts.accounts_payable_id || "";
      default:
        return accounts.bank_account_id || accounts.cash_account_id || "";
    }
  };

  /** Institutional expense posting: DR expense, CR settlement account. */
  const getExpenseAccountMappings = (paymentMethod?: string, overrideExpenseAccountId?: string) => ({
    expense_account_id: overrideExpenseAccountId || accounts.operating_expenses_id || "",
    payment_account_id: getSettlementAccount(paymentMethod),
  });

  /** Fixed asset acquisition / depreciation posting. */
  const getFixedAssetAccountMappings = (paymentMethod?: string) => ({
    fixed_asset_account_id: accounts.fixed_asset_account_id || "",
    payment_account_id: getSettlementAccount(paymentMethod || "bank"),
    depreciation_expense_id: accounts.depreciation_expense_id || "",
    accumulated_depreciation_account_id: accounts.accumulated_depreciation_account_id || "",
  });

  return {
    accounts,
    isLoading,
    isReady,
    getMissingAccounts,
    getSettlementAccount,
    getExpenseAccountMappings,
    getFixedAssetAccountMappings,
  };
}

// ─── Private fetcher ─────────────────────────────────────────────────

async function fetchExplicitSettings(
  orgId: string,
  businessId?: string,
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
      if (field) (mappings as any)[field] = row.account_id;
    }
  } catch {
    // Table may not exist yet in some environments
  }

  return mappings;
}
