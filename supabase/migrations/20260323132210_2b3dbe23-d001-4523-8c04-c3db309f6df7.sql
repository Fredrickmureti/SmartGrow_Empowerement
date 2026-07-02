-- Update validation trigger with complete QuickBooks-aligned detail type list
-- Adds ~25 new detail types across all account categories

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
  v_asset_types text[] := ARRAY[
    'accounts_receivable','cash_and_cash_equivalents','cash_on_hand','checking','savings',
    'money_market','mobile_money','trust_account','rents_held_in_trust',
    'allowance_bad_debts','assets_available_for_sale','development_costs','employee_advances',
    'inventory','investment_government','investment_tax_exempt','loans_to_officers',
    'loans_to_others','loans_to_stockholders','prepaid_expenses','retainage',
    'short_term_investments','undeposited_funds','other_current_asset',
    'accumulated_depreciation','accumulated_depletion','buildings','depletable_assets',
    'fixed_asset_computers','fixed_asset_copiers','fixed_asset_furniture','fixed_asset_phone',
    'fixed_asset_photo_video','fixed_asset_software','fixed_asset_other_tools',
    'furniture_fixtures','intangible_assets','land','leasehold_improvements',
    'machinery_equipment','other_fixed_asset','vehicles',
    'accumulated_amortization','assets_held_for_sale','deferred_tax_asset','goodwill',
    'lease_buyout','licenses','long_term_investments','organizational_costs',
    'security_deposits','other_non_current_asset'
  ];
  v_liability_types text[] := ARRAY[
    'accounts_payable','credit_card',
    'accrued_liabilities','trust_accounts_liability_current','current_tax_liability',
    'finance_lease_current','dividends_payable','insurance_payable','line_of_credit',
    'loan_payable_current','payroll_clearing','payroll_liabilities','payroll_tax_payable',
    'prepaid_expenses_payable','rents_in_trust_liability','sales_tax_payable',
    'state_local_tax_payable','trust_accounts_liability','unearned_revenue',
    'other_current_liability',
    'accrued_holiday_payable','accrued_non_current_liabilities','liabilities_held_for_sale',
    'long_term_borrowings','lease_obligations','notes_payable','shareholder_notes_payable',
    'other_non_current_liability'
  ];
  v_equity_types text[] := ARRAY[
    'accumulated_adjustment','dividend_disbursed','equity_in_subsidiaries',
    'share_capital','estimated_taxes','health_insurance_premium',
    'opening_balance_equity','other_comprehensive_income','owner_contributions',
    'owner_drawings','owners_equity','paid_in_capital','personal_expense',
    'personal_income','preferred_stock','retained_earnings','treasury_stock','other_equity'
  ];
  v_income_types text[] := ARRAY[
    'discount_refund','non_profit_income','other_primary_income','revenue_general',
    'sales_retail','sales_wholesale','sales_income','service_income',
    'unapplied_cash_payment_income',
    'dividend_income','interest_income','gain_on_asset_sales',
    'other_investment_income','other_operating_income','rental_income',
    'tax_exempt_interest','unrealized_loss_securities','other_income'
  ];
  v_expense_types text[] := ARRAY[
    'cost_of_labour','cost_of_goods_sold','equipment_rental_cos','freight_delivery_cos',
    'supplies_materials_cos','shipping_cos','other_cos',
    'advertising','amortization','auto','bad_debts','bank_charges',
    'charitable_contributions','commissions_fees','cost_of_labour_expense',
    'dues_subscriptions','entertainment','entertainment_meals','equipment_rental',
    'finance_costs','income_tax_expense','insurance_expense','interest_paid',
    'loss_discontinued_operations','management_compensation','legal_professional_fees',
    'meals_entertainment','office_expenses','other_business_expenses',
    'other_selling_expense','other_misc_service_cost',
    'payroll_expense','payroll_tax_expense','payroll_wage_expense','promotional_meals',
    'rent_expense','repair_maintenance','security_expenses','shipping_delivery',
    'supplies','taxes_paid','telephone_internet','travel','travel_meals',
    'travel_selling','unapplied_cash_bill_payment','utilities','depreciation',
    'exchange_gain_loss','penalties','loss_on_asset_sales','other_expense'
  ];
BEGIN
  v_account_type := NEW.account_type::text;
  v_detail_type := NEW.detail_type;
  IF v_detail_type IS NULL THEN
    RETURN NEW;
  END IF;
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