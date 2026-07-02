-- Extend backfill to cover bank-relevant detail types missing from v1:
--   mobile_money, credit_card, money_market, notes_payable
CREATE OR REPLACE FUNCTION public.backfill_account_detail_types(
  _org_id uuid DEFAULT NULL,
  _business_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer;
BEGIN
  WITH upd AS (
    UPDATE public.accounts a
    SET detail_type = CASE
      -- ASSETS — bank/cash family (most specific first)
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'mobile money|m-?pesa|airtel money|wallet|mobile wallet' THEN 'mobile_money'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'money market' THEN 'money_market'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'savings' THEN 'savings'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'petty cash|cash on hand|cash in hand|^cash$|cash drawer|till' THEN 'cash_on_hand'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'bank|checking|current account' THEN 'checking'
      WHEN a.account_type = 'asset' AND (lower(a.name) ~ 'receivable|debtor' OR a.code LIKE '12%') THEN 'accounts_receivable'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'inventory|stock' THEN 'inventory'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'input tax|tax input|gst receivable|prepaid tax' THEN 'tax_input'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'fixed asset|equipment|machinery|vehicle|building|land' THEN 'fixed_asset_other'
      WHEN a.account_type = 'asset' AND lower(a.name) ~ 'accumulated depreciation' THEN 'accumulated_depreciation'

      -- LIABILITIES — bank-related (credit card, loans) first
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'credit card|visa|mastercard|amex' THEN 'credit_card'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'loan|mortgage|note payable' THEN 'notes_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'line of credit|overdraft' THEN 'line_of_credit'
      WHEN a.account_type = 'liability' AND (lower(a.name) ~ 'payable|creditor' AND lower(a.name) !~ 'tax|vat') THEN 'accounts_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'sales tax|vat payable|output tax' THEN 'sales_tax_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'customer deposit|unearned' THEN 'customer_deposits'

      -- INCOME
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'service' THEN 'service_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'interest' THEN 'interest_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'rental|rent income' THEN 'rental_income'
      WHEN a.account_type = 'income' AND lower(a.name) ~ 'other income' THEN 'other_income'
      WHEN a.account_type = 'income' THEN 'sales_income'

      -- EXPENSE
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'cost of goods|cogs' THEN 'cost_of_goods_sold'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'depreciation' THEN 'depreciation'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'rent' THEN 'rent_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'salaries|wages|payroll' THEN 'payroll_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'utilit' THEN 'utilities'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'bank charge|bank fee' THEN 'bank_charges'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'insurance' THEN 'insurance_expense'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'office' THEN 'office_expenses'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'travel' THEN 'travel'
      WHEN a.account_type = 'expense' AND lower(a.name) ~ 'legal|professional' THEN 'legal_professional_fees'
      WHEN a.account_type = 'expense' THEN 'other_business_expenses'

      -- EQUITY
      WHEN a.account_type = 'equity' AND lower(a.name) ~ 'retained' THEN 'retained_earnings'
      WHEN a.account_type = 'equity' AND lower(a.name) ~ 'opening balance' THEN 'opening_balance_equity'
      ELSE a.detail_type
    END
    WHERE a.detail_type IS NULL
      AND (_org_id IS NULL OR a.organization_id = _org_id)
      AND (_business_id IS NULL OR a.business_id = _business_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM upd;
  RETURN COALESCE(v_updated, 0);
END;
$$;

-- Re-run backfill across the entire DB to pick up the new patterns
SELECT public.backfill_account_detail_types(NULL, NULL);