-- Wave 1B: Backfill canonical role identity
-- 1) Tag the neutral CoA skeleton rows with role_key by structural code.
UPDATE public.default_chart_of_accounts d
SET role_key = m.role_key
FROM (VALUES
  ('1111','cash'),
  ('1112','bank'),
  ('1120','accounts_receivable'),
  ('1130','inventory'),
  ('1210','fixed_asset'),
  ('1220','accumulated_depreciation'),
  ('1990','suspense'),
  ('2110','accounts_payable'),
  ('2130','output_tax'),
  ('2131','input_tax'),
  ('3190','opening_balance_equity'),
  ('3200','retained_earnings'),
  ('4100','sales_revenue'),
  ('4200','other_income'),
  ('5100','cogs'),
  ('6000','operating_expenses')
) AS m(code, role_key)
WHERE d.account_code = m.code
  AND d.is_country_neutral = true
  AND d.role_key IS NULL;

-- 2) Backfill accounts.system_role from default_account_settings (authoritative
--    runtime mapping). For each (business_id, role_key) pair, only the oldest
--    mapped account is stamped; duplicates remain NULL so the partial unique
--    index (business_id, system_role) holds. Wave 3 will merge duplicates.
WITH role_map AS (
  SELECT
    s.business_id,
    s.setting_key AS role_key,
    s.account_id,
    row_number() OVER (
      PARTITION BY s.business_id, s.setting_key
      ORDER BY a.created_at NULLS LAST, a.id
    ) AS rn
  FROM public.default_account_settings s
  JOIN public.accounts a ON a.id = s.account_id
  WHERE s.setting_key IN (SELECT role_key FROM public.system_account_roles)
)
UPDATE public.accounts a
SET system_role = rm.role_key
FROM role_map rm
WHERE rm.account_id = a.id
  AND rm.rn = 1
  AND a.system_role IS NULL;