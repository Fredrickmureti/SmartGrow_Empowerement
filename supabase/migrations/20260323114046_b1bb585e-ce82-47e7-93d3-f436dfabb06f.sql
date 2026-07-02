
-- Validation trigger: reject invalid account_type ↔ detail_type combinations
-- Only validates when detail_type IS NOT NULL (legacy accounts with NULL are allowed)

CREATE OR REPLACE FUNCTION public.validate_account_detail_type()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_type text;
  v_detail_type text;
  v_valid boolean := false;
  -- Asset detail types
  v_asset_types text[] := ARRAY[
    'accounts_receivable','cash_on_hand','checking','savings','money_market','mobile_money',
    'inventory','prepaid_expenses','undeposited_funds','employee_advances','allowance_bad_debts',
    'short_term_investments','other_current_asset',
    'buildings','furniture_fixtures','machinery_equipment','vehicles','land',
    'leasehold_improvements','accumulated_depreciation','other_fixed_asset',
    'goodwill','intangible_assets','security_deposits','long_term_investments',
    'accumulated_amortization','other_non_current_asset'
  ];
  -- Liability detail types
  v_liability_types text[] := ARRAY[
    'accounts_payable','credit_card','payroll_liabilities','sales_tax_payable',
    'current_tax_liability','loan_payable_current','unearned_revenue','accrued_liabilities',
    'insurance_payable','line_of_credit','other_current_liability',
    'notes_payable','long_term_borrowings','lease_obligations','other_non_current_liability'
  ];
  -- Equity detail types
  v_equity_types text[] := ARRAY[
    'owners_equity','share_capital','paid_in_capital','retained_earnings',
    'opening_balance_equity','owner_drawings','owner_contributions','other_equity'
  ];
  -- Income detail types
  v_income_types text[] := ARRAY[
    'sales_income','service_income','non_profit_income','discount_refund','other_primary_income',
    'interest_income','dividend_income','rental_income','gain_on_asset_sales','other_income'
  ];
  -- Expense detail types
  v_expense_types text[] := ARRAY[
    'cost_of_goods_sold','cost_of_labour','supplies_materials_cos','shipping_cos','other_cos',
    'advertising','auto','bad_debts','bank_charges','dues_subscriptions','insurance_expense',
    'interest_paid','legal_professional_fees','office_expenses','payroll_expense','rent_expense',
    'repair_maintenance','shipping_delivery','supplies','taxes_paid','telephone_internet',
    'travel','meals_entertainment','utilities','equipment_rental','security_expenses',
    'depreciation','amortization',
    'exchange_gain_loss','penalties','loss_on_asset_sales','other_expense'
  ];
BEGIN
  v_account_type := NEW.account_type::text;
  v_detail_type := NEW.detail_type;

  -- Allow NULL detail_type (legacy accounts)
  IF v_detail_type IS NULL THEN
    RETURN NEW;
  END IF;

  -- Validate combination
  CASE v_account_type
    WHEN 'asset' THEN v_valid := v_detail_type = ANY(v_asset_types);
    WHEN 'liability' THEN v_valid := v_detail_type = ANY(v_liability_types);
    WHEN 'equity' THEN v_valid := v_detail_type = ANY(v_equity_types);
    WHEN 'income' THEN v_valid := v_detail_type = ANY(v_income_types);
    WHEN 'expense' THEN v_valid := v_detail_type = ANY(v_expense_types);
    ELSE v_valid := false;
  END CASE;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'Invalid detail_type "%" for account_type "%". Detail type must match the account type.', v_detail_type, v_account_type;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_validate_account_detail_type ON public.accounts;

-- Create trigger for INSERT and UPDATE
CREATE TRIGGER trg_validate_account_detail_type
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_account_detail_type();
