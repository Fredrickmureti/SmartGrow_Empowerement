
INSERT INTO public.system_account_roles
  (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('service_revenue',     'Service Revenue',     'Income from services rendered',                            'income',    false, 'core',     51),
  ('sales_returns',       'Sales Returns / Refunds','Contra-revenue for refunds and returns to customers',    'income',    false, 'core',     52),
  ('discount_given',      'Discounts Given',     'Discounts granted to customers (early payment, promo)',    'expense',   false, 'core',     61),
  ('discount_received',   'Discounts Received',  'Discounts received from suppliers (early payment)',        'income',    false, 'core',     62),
  ('purchase_returns',    'Purchase Returns',    'Contra-expense for returns to suppliers',                  'expense',   false, 'core',     63),
  ('bank_fees',           'Bank Fees & Charges', 'Bank service fees, wire fees, overdraft fees',             'expense',   false, 'advanced', 70),
  ('fx_realized_gain',    'FX Realized Gain',    'Realized foreign-exchange gain on settlements',            'income',    false, 'advanced', 71),
  ('fx_realized_loss',    'FX Realized Loss',    'Realized foreign-exchange loss on settlements',            'expense',   false, 'advanced', 72),
  ('rounding_gain',       'Rounding Gain',       'Cash rounding gain (smallest-denomination rounding)',      'income',    false, 'advanced', 73),
  ('rounding_loss',       'Rounding Loss',       'Cash rounding loss (smallest-denomination rounding)',      'expense',   false, 'advanced', 74),
  ('clearing_pos',        'POS Clearing',        'Holding account between POS session close and bank deposit','asset',    false, 'advanced', 75),
  ('clearing_undeposited_funds','Undeposited Funds','Cash/cheques received but not yet deposited',           'asset',     false, 'advanced', 76)
ON CONFLICT (role_key) DO NOTHING;

DELETE FROM public.account_role_eligibility;

INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority) VALUES
  ('accounts_receivable', 'asset', 'accounts_receivable', 1),
  ('bank',                'asset', 'checking',            1),
  ('bank',                'asset', 'savings',             2),
  ('bank',                'asset', 'money_market',        3),
  ('bank',                'asset', 'cash_and_cash_equivalents', 4),
  ('cash',                'asset', 'cash_on_hand',        1),
  ('cash',                'asset', 'undeposited_funds',   2),
  ('mpesa',               'asset', 'mobile_money',        1),
  ('mpesa',               'asset', 'cash_on_hand',        2),
  ('mpesa',               'asset', 'undeposited_funds',   3),
  ('mobile_money',        'asset', 'mobile_money',        1),
  ('mobile_money',        'asset', 'cash_on_hand',        2),
  ('mobile_money',        'asset', 'undeposited_funds',   3),
  ('credit_card_clearing','asset', 'undeposited_funds',   1),
  ('credit_card_clearing','asset', 'other_current_asset', 2),
  ('clearing_pos',              'asset', 'undeposited_funds',   1),
  ('clearing_pos',              'asset', 'other_current_asset', 2),
  ('clearing_undeposited_funds','asset', 'undeposited_funds',   1),
  ('inventory',           'asset', 'inventory',           1),
  ('input_tax',           'asset', 'other_current_asset', 1),
  ('suspense',            'asset', 'suspense',            1),
  ('suspense',            'asset', 'other_current_asset', 2),
  ('fixed_asset',         'asset', 'machinery_equipment', 1),
  ('fixed_asset',         'asset', 'furniture_fixtures',  2),
  ('fixed_asset',         'asset', 'buildings',           3),
  ('fixed_asset',         'asset', 'vehicles',            4),
  ('fixed_asset',         'asset', 'land',                5),
  ('fixed_asset',         'asset', 'leasehold_improvements', 6),
  ('fixed_asset',         'asset', 'fixed_asset_computers',  7),
  ('fixed_asset',         'asset', 'fixed_asset_furniture',  8),
  ('fixed_asset',         'asset', 'other_fixed_asset',      9),
  ('accumulated_depreciation', 'asset', 'accumulated_depreciation', 1),
  ('accounts_payable',    'liability', 'accounts_payable',         1),
  ('output_tax',          'liability', 'sales_tax_payable',        1),
  ('output_tax',          'liability', 'current_tax_liability',    2),
  ('output_tax',          'liability', 'other_current_liabilities',3),
  ('customer_deposits',   'liability', 'customer_deposits',        1),
  ('customer_deposits',   'liability', 'unearned_revenue',         2),
  ('customer_deposits',   'liability', 'other_current_liabilities',3),
  ('opening_balance_equity', 'equity', 'opening_balance_equity', 1),
  ('retained_earnings',      'equity', 'retained_earnings',      1),
  ('sales_revenue',       'income', 'sales_income',          1),
  ('sales_revenue',       'income', 'service_income',        2),
  ('sales_revenue',       'income', 'other_primary_income',  3),
  ('sales_revenue',       'income', 'cash_receipt_income',   4),
  ('service_revenue',     'income', 'service_income',        1),
  ('service_revenue',     'income', 'sales_income',          2),
  ('service_revenue',     'income', 'other_primary_income',  3),
  ('sales_returns',       'income', 'discounts_refunds_given', 1),
  ('sales_returns',       'income', 'sales_income',            2),
  ('discount_received',   'income', 'other_misc_income',     1),
  ('discount_received',   'income', 'other_income',          2),
  ('other_income',        'income', 'other_misc_income',     1),
  ('other_income',        'income', 'other_income',          2),
  ('other_income',        'income', 'interest_income',       3),
  ('other_income',        'income', 'rental_income',         4),
  ('other_income',        'income', 'royalty_income',        5),
  ('other_income',        'income', 'gain_on_asset_sales',   6),
  ('other_income',        'income', 'dividend_income',       7),
  ('other_income',        'income', 'gain_on_investments',   8),
  ('fx_realized_gain',    'income', 'other_income',          1),
  ('fx_realized_gain',    'income', 'other_misc_income',     2),
  ('fx_realized_gain',    'income', 'gain_on_investments',   3),
  ('rounding_gain',       'income', 'other_misc_income',     1),
  ('rounding_gain',       'income', 'other_income',          2),
  ('cogs',                'expense', 'cost_of_goods_sold',              1),
  ('cogs',                'expense', 'cost_of_sales_other',             2),
  ('cogs',                'expense', 'cost_of_sales_supplies_materials',3),
  ('cogs',                'expense', 'cost_of_sales_shipping_freight',  4),
  ('cogs',                'expense', 'cost_of_sales_equipment_rental',  5),
  ('cogs',                'expense', 'cost_of_labor_cos',               6),
  ('cogs',                'expense', 'other_cos',                       7),
  ('cogs',                'expense', 'other_misc_service_cost',         8),
  ('purchase_returns',    'expense', 'other_business_expenses',         1),
  ('purchase_returns',    'expense', 'other_expense',                   2),
  ('discount_given',      'expense', 'other_business_expenses',         1),
  ('discount_given',      'expense', 'other_selling_expense',           2),
  ('discount_given',      'expense', 'other_expense',                   3),
  ('bank_fees',           'expense', 'bank_charges',                    1),
  ('bank_fees',           'expense', 'finance_costs',                   2),
  ('bank_fees',           'expense', 'other_business_expenses',         3),
  ('fx_realized_loss',    'expense', 'exchange_gain_loss',              1),
  ('fx_realized_loss',    'expense', 'finance_costs',                   2),
  ('fx_realized_loss',    'expense', 'other_expense',                   3),
  ('rounding_loss',       'expense', 'other_expense',                   1),
  ('rounding_loss',       'expense', 'other_business_expenses',         2),
  ('depreciation_expense','expense', 'depreciation',                    1),
  ('depreciation_expense','expense', 'amortization',                    2),
  ('inventory_adjustment','expense', 'other_business_expenses',         1),
  ('inventory_adjustment','expense', 'cost_of_sales_other',             2),
  ('inventory_adjustment','expense', 'other_expense',                   3),
  ('operating_expenses',  'expense', 'other_business_expenses',         1),
  ('operating_expenses',  'expense', 'office_expenses',                 2),
  ('operating_expenses',  'expense', 'utilities',                       3),
  ('operating_expenses',  'expense', 'rent_expense',                    4),
  ('operating_expenses',  'expense', 'supplies',                        5),
  ('operating_expenses',  'expense', 'repair_maintenance',              6),
  ('operating_expenses',  'expense', 'telephone_internet',              7),
  ('operating_expenses',  'expense', 'other_expense',                   8);

UPDATE public.accounts a SET detail_type = m.detail_type
FROM (VALUES
  ('1000','cash_on_hand'),
  ('1010','checking'),
  ('1100','accounts_receivable'),
  ('1200','inventory'),
  ('1300','other_current_asset'),
  ('1500','machinery_equipment'),
  ('1510','furniture_fixtures'),
  ('1520','buildings'),
  ('1530','vehicles'),
  ('1590','accumulated_depreciation'),
  ('2000','accounts_payable'),
  ('2100','sales_tax_payable'),
  ('2200','customer_deposits'),
  ('3000','opening_balance_equity'),
  ('3100','retained_earnings'),
  ('4000','sales_income'),
  ('4100','sales_income'),
  ('4110','sales_income'),
  ('4200','service_income'),
  ('4900','other_misc_income'),
  ('5000','cost_of_goods_sold'),
  ('5100','cost_of_goods_sold'),
  ('6000','other_business_expenses'),
  ('6100','office_expenses'),
  ('6200','utilities'),
  ('6300','rent_expense'),
  ('6400','bank_charges'),
  ('6500','depreciation'),
  ('6900','other_expense')
) AS m(code, detail_type)
WHERE a.code = m.code
  AND a.detail_type IS NULL
  AND EXISTS (
    SELECT 1 FROM public.account_detail_type_catalog c
    WHERE c.detail_type = m.detail_type AND c.account_type = a.account_type
  );

CREATE INDEX IF NOT EXISTS idx_default_account_mapping_audit_lookup
  ON public.default_account_mapping_audit (organization_id, business_id, role_key, created_at DESC);

DO $$
DECLARE missing_role text;
BEGIN
  SELECT r.role_key INTO missing_role
  FROM public.system_account_roles r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.account_role_eligibility e WHERE e.role_key = r.role_key
  )
  LIMIT 1;
  IF missing_role IS NOT NULL THEN
    RAISE EXCEPTION 'Eligibility seed incomplete: role % has no eligibility rows', missing_role;
  END IF;
END $$;
