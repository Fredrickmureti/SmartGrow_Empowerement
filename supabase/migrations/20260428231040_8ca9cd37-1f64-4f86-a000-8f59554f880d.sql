
-- 0. Extend the curated detail_type allowlist with 'suspense' (asset clearing).
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
    'short_term_investments','undeposited_funds','suspense','other_current_asset',
    'tax_input',
    'accumulated_depreciation','accumulated_depletion','buildings','depletable_assets',
    'fixed_asset_computers','fixed_asset_copiers','fixed_asset_furniture','fixed_asset_phone',
    'fixed_asset_photo_video','fixed_asset_software','fixed_asset_other_tools',
    'fixed_asset_other',
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
    'customer_deposits','other_current_liability',
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

-- 1. Add OBE + Suspense to every country template (idempotent)
INSERT INTO public.default_chart_of_accounts
  (country_code, account_code, account_name, account_type, parent_code, description, detail_type, is_country_neutral, is_system)
SELECT DISTINCT country_code, '3190', 'Opening Balance Equity', 'equity'::account_type, '3000',
       'Auto-managed clearing account used for opening balances and migrations',
       'opening_balance_equity', true, true
FROM public.default_chart_of_accounts
WHERE NOT EXISTS (
  SELECT 1 FROM public.default_chart_of_accounts d2
  WHERE d2.country_code = public.default_chart_of_accounts.country_code AND d2.account_code = '3190'
);

INSERT INTO public.default_chart_of_accounts
  (country_code, account_code, account_name, account_type, parent_code, description, detail_type, is_country_neutral, is_system)
SELECT DISTINCT country_code, '1990', 'Suspense', 'asset'::account_type, '1000',
       'Auto-managed clearing account for unmatched bank transactions',
       'suspense', true, true
FROM public.default_chart_of_accounts
WHERE NOT EXISTS (
  SELECT 1 FROM public.default_chart_of_accounts d2
  WHERE d2.country_code = public.default_chart_of_accounts.country_code AND d2.account_code = '1990'
);

-- 2. Backfill OBE + Suspense into every existing business that lacks them
DO $$
DECLARE
  _b record;
BEGIN
  FOR _b IN SELECT DISTINCT b.id AS business_id, b.organization_id FROM public.businesses b
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.business_id = _b.business_id
        AND (a.detail_type = 'opening_balance_equity' OR a.code = '3190'
             OR lower(a.name) LIKE '%opening balance equity%')
    ) THEN
      INSERT INTO public.accounts
        (organization_id, business_id, code, name, account_type, detail_type, description, is_system, is_active)
      VALUES (_b.organization_id, _b.business_id, '3190', 'Opening Balance Equity',
        'equity'::account_type, 'opening_balance_equity',
        'Auto-managed clearing account used for opening balances and migrations', true, true)
      ON CONFLICT DO NOTHING;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.business_id = _b.business_id
        AND (a.detail_type = 'suspense' OR a.code = '1990'
             OR lower(a.name) LIKE '%suspense%')
    ) THEN
      INSERT INTO public.accounts
        (organization_id, business_id, code, name, account_type, detail_type, description, is_system, is_active)
      VALUES (_b.organization_id, _b.business_id, '1990', 'Suspense',
        'asset'::account_type, 'suspense',
        'Auto-managed clearing account for unmatched bank transactions', true, true)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- 3. Auto-map for every business that has the account but no mapping
INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
SELECT a.organization_id, a.business_id, 'opening_balance_equity', a.id
FROM public.accounts a
WHERE a.detail_type = 'opening_balance_equity' AND a.is_active = true
  AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                  WHERE d.business_id = a.business_id AND d.setting_key = 'opening_balance_equity')
ON CONFLICT DO NOTHING;

INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
SELECT a.organization_id, a.business_id, 'suspense', a.id
FROM public.accounts a
WHERE a.detail_type = 'suspense' AND a.is_active = true
  AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                  WHERE d.business_id = a.business_id AND d.setting_key = 'suspense')
ON CONFLICT DO NOTHING;

-- 4. Canonicalise COGS key
DELETE FROM public.default_account_settings d
WHERE d.setting_key = 'cogs'
  AND EXISTS (SELECT 1 FROM public.default_account_settings d2
              WHERE d2.setting_key = 'cost_of_goods_sold'
                AND d2.business_id IS NOT DISTINCT FROM d.business_id
                AND d2.organization_id IS NOT DISTINCT FROM d.organization_id);

UPDATE public.default_account_settings SET setting_key = 'cost_of_goods_sold' WHERE setting_key = 'cogs';

-- 5. Validator: OBE + Suspense are advisory, not required
CREATE OR REPLACE FUNCTION public.validate_required_system_roles(_business_id uuid)
RETURNS TABLE(setting_key text, is_required boolean, suggested_account_type text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH required(setting_key, is_required, suggested_account_type) AS (
    VALUES
      ('cash',                   true,  'asset'),
      ('bank',                   true,  'asset'),
      ('accounts_receivable',    true,  'asset'),
      ('accounts_payable',       true,  'liability'),
      ('sales_revenue',          true,  'income'),
      ('retained_earnings',      true,  'equity'),
      ('cost_of_goods_sold',     false, 'expense'),
      ('inventory',              false, 'asset'),
      ('inventory_adjustment',   false, 'expense'),
      ('output_tax',             false, 'liability'),
      ('input_tax',              false, 'asset'),
      ('opening_balance_equity', false, 'equity'),
      ('suspense',               false, 'asset')
  )
  SELECT r.setting_key, r.is_required, r.suggested_account_type
  FROM required r
  LEFT JOIN public.default_account_settings d
    ON d.business_id = _business_id AND d.setting_key = r.setting_key
  WHERE d.id IS NULL
  ORDER BY r.is_required DESC, r.setting_key;
$$;

GRANT EXECUTE ON FUNCTION public.validate_required_system_roles(uuid) TO authenticated;

-- 6. Seeder auto-maps OBE/Suspense for new businesses
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid, _business_id uuid, _country_code text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country AND is_country_neutral = true
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
    ORDER BY account_code
  LOOP
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := NULLIF(_code_to_id->>_template.parent_code, '')::uuid;
    END IF;

    INSERT INTO public.accounts (
      organization_id, business_id, code, name, account_type,
      detail_type, parent_id, description, is_system, is_active
    ) VALUES (
      _org_id, _business_id, _template.account_code, _template.account_name,
      _template.account_type, _template.detail_type,
      _parent_id, _template.description,
      coalesce(_template.is_system, false), true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO _new_id;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  PERFORM public.backfill_account_detail_types(_org_id, _business_id);

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'opening_balance_equity', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'opening_balance_equity' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'opening_balance_equity')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'suspense', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'suspense' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'suspense')
  ON CONFLICT DO NOTHING;

  RETURN _accounts_created;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.provision_default_chart_of_accounts(uuid, uuid, text) TO authenticated;

-- 7. Update the delete-protection trigger to use the canonical required-key list
CREATE OR REPLACE FUNCTION public.prevent_unmapped_system_role_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _required_keys text[] := ARRAY[
    'cash','bank','accounts_receivable','accounts_payable',
    'sales_revenue','retained_earnings'
  ];
  _replacement_exists boolean;
BEGIN
  IF NOT (OLD.setting_key = ANY(_required_keys)) THEN RETURN OLD; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.default_account_settings
     WHERE setting_key = OLD.setting_key
       AND business_id IS NOT DISTINCT FROM OLD.business_id
       AND organization_id IS NOT DISTINCT FROM OLD.organization_id
       AND id <> OLD.id
  ) INTO _replacement_exists;
  IF NOT _replacement_exists THEN
    RAISE EXCEPTION 'Cannot delete the only mapping for required system role "%". Map a replacement account first.', OLD.setting_key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;
