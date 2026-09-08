CREATE OR REPLACE FUNCTION public.validate_required_system_roles(_business_id uuid)
RETURNS TABLE(setting_key text, is_required boolean, suggested_account_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH required(setting_key, is_required, suggested_account_type) AS (
    VALUES
      ('cash',                     true,  'asset'),
      ('bank',                     true,  'asset'),
      ('mobile_money',             true,  'asset'),
      ('accounts_payable',         true,  'liability'),
      ('retained_earnings',        true,  'equity'),
      ('operating_expenses',       false, 'expense'),
      ('other_income',             false, 'income'),
      ('output_tax',               false, 'liability'),
      ('input_tax',                false, 'asset'),
      ('fixed_asset',              false, 'asset'),
      ('accumulated_depreciation', false, 'asset'),
      ('depreciation_expense',     false, 'expense'),
      ('opening_balance_equity',   false, 'equity'),
      ('suspense',                 false, 'asset')
  )
  SELECT r.setting_key, r.is_required, r.suggested_account_type
  FROM required r
  LEFT JOIN public.default_account_settings d
    ON d.business_id = _business_id AND d.setting_key = r.setting_key
  WHERE d.id IS NULL
  ORDER BY r.is_required DESC, r.setting_key;
$$;
