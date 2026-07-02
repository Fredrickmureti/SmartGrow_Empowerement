
-- Update validation trigger with expanded QuickBooks-aligned detail type list

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
    'trust_account','rents_held_in_trust',
    'allowance_bad_debts','development_costs','employee_advances','inventory',
    'investment_government','investment_tax_exempt','loans_to_officers','loans_to_others',
    'loans_to_stockholders','prepaid_expenses','retainage','short_term_investments',
    'undeposited_funds','other_current_asset',
    'accumulated_depreciation','accumulated_depletion','buildings','depletable_assets',
    'fixed_asset_computers','fixed_asset_copiers','fixed_asset_furniture','fixed_asset_phone',
    'fixed_asset_photo_video','fixed_asset_software','fixed_asset_other_tools',
    'furniture_fixtures','intangible_assets','land','leasehold_improvements',
    'machinery_equipment','other_fixed_asset','vehicles',
    'accumulated_amortization','goodwill','lease_buyout','licenses',
    'long_term_investments','security_deposits','other_non_current_asset'
  ];
  -- Liability detail types
  v_liability_types text[] := ARRAY[
    'accounts_payable','credit_card',
    'accrued_liabilities','current_tax_liability','insurance_payable','line_of_credit',
    'loan_payable_current','payroll_clearing','payroll_liabilities','payroll_tax_payable',
    'prepaid_expenses_payable','rents_in_trust_liability','sales_tax_payable',
    'state_local_tax_payable','trust_accounts_liability','unearned_revenue',
    'other_current_liability',
    'long_term_borrowings','lease_obligations','notes_payable','shareholder_notes_payable',
    'other_non_current_liability'
  ];
  -- Equity detail types
  v_equity_types text[] := ARRAY[
    'accumulated_adjustment','share_capital','estimated_taxes','health_insurance_premium',
    'opening_balance_equity','owner_contributions','owner_drawings','owners_equity',
    'paid_in_capital','personal_expense','personal_income','preferred_stock',
    'retained_earnings','treasury_stock','other_equity'
  ];
  -- Income detail types
  v_income_types text[] := ARRAY[
    'sales_income','service_income','non_profit_income','discount_refund',
    'other_primary_income','unapplied_cash_payment_income',
    'interest_income','dividend_income','other_investment_income','rental_income',
    'tax_exempt_interest','gain_on_asset_sales','other_income'
  ];
  -- Expense detail types
  v_expense_types text[] := ARRAY[
    'cost_of_goods_sold','cost_of_labour','equipment_rental_cos','supplies_materials_cos',
    'shipping_cos','other_cos',
    'advertising','auto','bad_debts','bank_charges','charitable_contributions',
    'dues_subscriptions','entertainment','entertainment_meals','equipment_rental',
    'finance_costs','insurance_expense','interest_paid','legal_professional_fees',
    'office_expenses','other_business_expenses','other_misc_service_cost',
    'payroll_expense','payroll_tax_expense','payroll_wage_expense','promotional_meals',
    'rent_expense','repair_maintenance','security_expenses','shipping_delivery',
    'supplies','taxes_paid','telephone_internet','travel','travel_meals',
    'meals_entertainment','unapplied_cash_bill_payment','utilities',
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
