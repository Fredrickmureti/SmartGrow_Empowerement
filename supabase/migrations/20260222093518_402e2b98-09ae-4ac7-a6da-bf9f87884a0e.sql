
-- P0-2: Add cash_flow_category to accounts for data-driven cash flow classification
-- Replaces hardcoded code-range logic in useCashFlowReport.ts

-- Add the column (nullable, no disruption to existing flows)
ALTER TABLE public.accounts
ADD COLUMN IF NOT EXISTS cash_flow_category text;

-- Create an index for report queries
CREATE INDEX IF NOT EXISTS idx_accounts_cash_flow_category
ON public.accounts (cash_flow_category)
WHERE cash_flow_category IS NOT NULL;

-- Populate existing accounts based on the same code-range rules currently hardcoded
-- This preserves current behavior while making it configurable going forward
UPDATE public.accounts SET cash_flow_category = CASE
  WHEN account_type = 'income' THEN 'operating_income'
  WHEN account_type = 'expense' THEN 'operating_expense'
  WHEN account_type = 'equity' THEN 'financing_equity'
  WHEN account_type = 'asset' THEN
    CASE
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 1000 AND CAST(code AS integer) < 1100 THEN 'cash'
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 1100 AND CAST(code AS integer) < 1200 THEN 'operating_receivable'
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 1200 AND CAST(code AS integer) < 1500 THEN 'operating_inventory'
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 1500 AND CAST(code AS integer) < 1800 THEN 'investing_fixed_asset'
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 1800 AND CAST(code AS integer) < 1900 THEN 'investing_depreciation'
      ELSE 'operating_other_current_asset'
    END
  WHEN account_type = 'liability' THEN
    CASE
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 2000 AND CAST(code AS integer) < 2100 THEN 'operating_payable'
      WHEN code ~ '^\d+$' AND CAST(code AS integer) >= 2500 AND CAST(code AS integer) < 2700 THEN 'financing_loan'
      ELSE 'operating_other_current_liability'
    END
  ELSE NULL
END
WHERE cash_flow_category IS NULL;

-- Add a comment for documentation
COMMENT ON COLUMN public.accounts.cash_flow_category IS 'Cash flow statement classification: cash, operating_receivable, operating_payable, operating_inventory, operating_income, operating_expense, operating_other_current_asset, operating_other_current_liability, investing_fixed_asset, investing_depreciation, financing_loan, financing_equity. Configurable per-account.';
