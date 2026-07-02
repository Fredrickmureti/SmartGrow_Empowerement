
-- ============================================================
-- 1. Fix detail_type inference: never label payroll payables as trade AP
-- ============================================================

CREATE OR REPLACE FUNCTION public.backfill_account_detail_types(_org_id uuid DEFAULT NULL::uuid, _business_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH upd AS (
    UPDATE public.accounts a
    SET detail_type = CASE
      -- ASSETS
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

      -- LIABILITIES — bank-related first
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'credit card|visa|mastercard|amex' THEN 'credit_card'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'loan|mortgage|note payable' THEN 'notes_payable'
      WHEN a.account_type = 'liability' AND lower(a.name) ~ 'line of credit|overdraft' THEN 'line_of_credit'
      -- Trade AP only: explicitly exclude payroll/statutory/tax payables so they
      -- don't pollute AP aging and don't collide with payroll_account_role_policy.
      WHEN a.account_type = 'liability'
           AND (lower(a.name) ~ 'payable|creditor')
           AND lower(a.name) !~ 'tax|vat|salary|salaries|payroll|pension|nssf|shif|nhif|ahl|nita|paye|statutory|withheld|withholding|net salary'
           AND COALESCE(a.code, '') NOT IN ('2140','2150','2160','2170')
        THEN 'accounts_payable'
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
$function$;

-- ============================================================
-- 2. One-time data repair: undo the bad AP labels on payroll payables.
--    Idempotent. Only touches accounts that match the canonical payroll
--    codes OR carry a payroll-specific name pattern.
-- ============================================================

UPDATE public.accounts
SET detail_type = NULL
WHERE detail_type = 'accounts_payable'
  AND (
    code IN ('2140','2150','2160','2170')
    OR lower(name) ~ 'salary|salaries|payroll|pension|nssf|shif|nhif|ahl|nita|paye|statutory|withheld|withholding|net salary'
  );

-- ============================================================
-- 3. Suggester now respects payroll_account_role_policy. The writer and
--    the suggester agree by construction; the Apply CTA can no longer
--    propose an account the validator will reject.
-- ============================================================

CREATE OR REPLACE FUNCTION public.payroll_gl_readiness(_org_id uuid, _business_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(setting_key text, label text, rule_code text, kind text, required_account_type text,
              is_mapped boolean, suggested_account_id uuid, suggested_account_label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH rules AS (
    SELECT psr.rule_code, psr.rule_name, psr.rule_type, psr.parameters,
           n.needs_employee, n.needs_employer
    FROM public.payroll_statutory_rules psr,
         LATERAL public._payroll_rule_needs(psr) n
    WHERE psr.organization_id = _org_id
      AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= CURRENT_DATE)
  ),
  needed AS (
    SELECT 'salary_expense'::text AS setting_key, 'Salary Expense'::text AS label,
           NULL::text AS rule_code, 'core'::text AS kind, 'expense'::text AS required_account_type
    UNION ALL
    SELECT 'net_salary_payable', 'Net Salary Payable', NULL, 'core', 'liability'
    UNION ALL
    SELECT r.rule_code || '_payable', COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employee_payable', 'liability'
    FROM rules r WHERE r.needs_employee
    UNION ALL
    SELECT r.rule_code || '_employer_expense', COALESCE(r.rule_name, r.rule_code) || ' — Employer Expense',
           r.rule_code, 'employer_expense', 'expense'
    FROM rules r WHERE r.needs_employer
    UNION ALL
    SELECT r.rule_code || '_payable', COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employer_payable', 'liability'
    FROM rules r WHERE r.needs_employer AND NOT r.needs_employee
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (setting_key) setting_key, label, rule_code, kind, required_account_type
    FROM needed
    ORDER BY setting_key,
      CASE kind WHEN 'core' THEN 0 WHEN 'employee_payable' THEN 1
                WHEN 'employer_expense' THEN 2 ELSE 3 END
  ),
  effective_mappings AS (
    SELECT DISTINCT ON (das.setting_key) das.setting_key, das.account_id
    FROM public.default_account_settings das
    WHERE das.organization_id = _org_id
      AND (_business_id IS NULL OR das.business_id IS NULL OR das.business_id = _business_id)
    ORDER BY das.setting_key, (das.business_id IS NOT NULL) DESC
  ),
  candidates AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type, a.detail_type
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND (_business_id IS NULL OR a.business_id IS NULL OR a.business_id = _business_id)
  ),
  -- Apply the same rules as _payroll_assert_mapping_role so suggestions
  -- are guaranteed to pass validation when applied.
  valid_candidates AS (
    SELECT n.setting_key, c.id AS account_id, c.code, c.name, c.detail_type
    FROM needed_dedup n
    JOIN candidates c ON c.account_type = n.required_account_type
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.payroll_account_role_policy p
      WHERE n.setting_key LIKE p.setting_key_pattern ESCAPE '\'
        AND (
          NOT (c.account_type = ANY (p.allowed_account_types))
          OR (c.detail_type IS NOT NULL AND c.detail_type = ANY (p.denied_detail_types))
        )
    )
  ),
  ranked AS (
    SELECT v.setting_key, v.account_id,
      ROW_NUMBER() OVER (
        PARTITION BY v.setting_key
        ORDER BY
          CASE WHEN n.rule_code IS NOT NULL
                    AND (lower(v.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                         OR lower(v.code) ILIKE '%'||lower(n.rule_code)||'%')
               THEN 0
               WHEN lower(v.name) ILIKE '%'||lower(replace(v.setting_key,'_',' '))||'%'
               THEN 1
               ELSE 2
          END,
          v.code
      ) AS rn
    FROM valid_candidates v
    JOIN needed_dedup n ON n.setting_key = v.setting_key
  ),
  suggestions AS (SELECT setting_key, account_id FROM ranked WHERE rn = 1)
  SELECT n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
         (em.account_id IS NOT NULL) AS is_mapped,
         CASE WHEN em.account_id IS NULL THEN s.account_id END AS suggested_account_id,
         CASE WHEN em.account_id IS NULL THEN
           (SELECT a.code || ' — ' || a.name FROM public.accounts a WHERE a.id = s.account_id)
         END AS suggested_account_label
  FROM needed_dedup n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN suggestions s ON s.setting_key = n.setting_key
  ORDER BY n.kind, n.setting_key;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_gl_readiness(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 4. Localization-pack visibility — replace `USING (true)` with country +
--    publication scoping. Platform admins keep their FOR ALL policy.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_country_codes()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(ARRAY_AGG(DISTINCT upper(b.country)), ARRAY[]::text[])
  FROM public.user_roles ur
  JOIN public.businesses b ON b.organization_id = ur.organization_id
  WHERE ur.user_id = auth.uid()
    AND ur.is_active = true
    AND b.country IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.current_user_country_codes() TO authenticated, service_role;

DROP POLICY IF EXISTS "Localization packs are publicly readable" ON public.localization_packs;

CREATE POLICY "Tenants see published packs for their country"
ON public.localization_packs
FOR SELECT
TO authenticated
USING (
  is_published = true
  AND COALESCE(is_active, true) = true
  AND upper(country_code) = ANY (public.current_user_country_codes())
);

COMMENT ON FUNCTION public.current_user_country_codes() IS
  'Returns the set of country codes (uppercased) attached to businesses the caller has an active role in. Used by localization_packs RLS to scope pack discovery to relevant countries.';

COMMENT ON POLICY "Tenants see published packs for their country" ON public.localization_packs IS
  'Replaces the previous USING(true) policy. Tenants only see active+published packs for their own country. Platform admins keep full access via the is_platform_admin policy.';
