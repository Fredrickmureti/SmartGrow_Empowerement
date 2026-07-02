
-- Phase 3 — collapse the duplicate hardcoded payroll role matrix.
-- The previous version of payroll_mapping_findings re-encoded the same
-- "no salary->COGS, no payable->generic AP, no payable->header" rules that
-- already live in payroll_account_role_policy + _payroll_assert_mapping_role.
-- Two sources of truth = guaranteed drift. This rewrite reads the policy
-- table directly so the UI findings, the BEFORE-write trigger, and the
-- post-payroll-gl pre-check all consult the same matrix.

CREATE OR REPLACE VIEW public.payroll_mapping_findings AS
WITH payroll_rows AS (
  SELECT
    das.organization_id,
    das.business_id,
    das.setting_key,
    a.id   AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type::text AS account_type,
    a.detail_type,
    COALESCE(a.is_header, false) AS is_header
  FROM public.default_account_settings das
  JOIN public.accounts a ON a.id = das.account_id
  -- Exclude the canonical AR/AP-module mappings; they legitimately point at
  -- 2110 Accounts Payable / 1200 Accounts Receivable. Only payroll-shaped
  -- setting_keys are subject to the payroll role policy.
  WHERE das.setting_key NOT IN ('accounts_payable','accounts_receivable')
    AND (
      das.setting_key = 'salary_expense'
      OR das.setting_key = 'net_salary_payable'
      OR das.setting_key LIKE '%\_employer\_expense' ESCAPE '\'
      OR das.setting_key LIKE '%\_payable' ESCAPE '\'
    )
),
-- For each payroll row, evaluate it against every policy whose pattern matches.
-- A row fails the role policy if (a) any matching policy's allowed_account_types
-- does not contain the row's account_type, or (b) any matching policy's
-- denied_detail_types contains the row's detail_type.
violations AS (
  SELECT
    pr.organization_id, pr.business_id, pr.setting_key,
    pr.account_id, pr.account_code, pr.account_name, pr.account_type,
    pr.detail_type, pr.is_header,
    CASE
      WHEN pr.is_header THEN 'payroll_mapping_header_account'
      WHEN EXISTS (
        SELECT 1 FROM public.payroll_account_role_policy p
        WHERE pr.setting_key LIKE p.setting_key_pattern ESCAPE '\'
          AND NOT (pr.account_type = ANY (p.allowed_account_types))
      ) THEN 'payroll_mapping_wrong_account_type'
      WHEN EXISTS (
        SELECT 1 FROM public.payroll_account_role_policy p
        WHERE pr.setting_key LIKE p.setting_key_pattern ESCAPE '\'
          AND pr.detail_type IS NOT NULL
          AND pr.detail_type = ANY (p.denied_detail_types)
      ) THEN
        CASE
          WHEN pr.detail_type = 'cost_of_goods_sold' THEN 'salary_expense_mapped_to_cogs'
          WHEN pr.detail_type = 'accounts_payable' THEN 'payroll_payable_mapped_to_generic_ap'
          ELSE 'payroll_mapping_denied_detail_type'
        END
      -- Defense-in-depth: even if no policy row matched the setting_key
      -- pattern (e.g. a typo), still catch the historically-observed
      -- salary -> COGS account drift.
      WHEN (pr.setting_key = 'salary_expense'
            OR pr.setting_key LIKE '%\_employer\_expense' ESCAPE '\')
           AND public._payroll_is_cogs_account(pr.account_id)
        THEN 'salary_expense_mapped_to_cogs'
      ELSE NULL
    END AS violation_code
  FROM payroll_rows pr
)
SELECT
  organization_id, business_id, setting_key,
  account_id, account_code, account_name, account_type,
  violation_code,
  CASE violation_code
    WHEN 'salary_expense_mapped_to_cogs'         THEN 'critical'
    WHEN 'payroll_mapping_header_account'        THEN 'critical'
    WHEN 'payroll_mapping_wrong_account_type'    THEN 'critical'
    WHEN 'payroll_payable_mapped_to_generic_ap'  THEN 'warning'
    WHEN 'payroll_mapping_denied_detail_type'    THEN 'warning'
  END AS severity,
  CASE violation_code
    WHEN 'salary_expense_mapped_to_cogs' THEN
      'Payroll salary / employer-expense is posted to a Cost of Goods Sold account. This distorts gross margin and COGS reports. Remap to a Payroll Expenses / Salaries & Wages account.'
    WHEN 'payroll_mapping_header_account' THEN
      'Payroll mapping points at a header / parent account. Header accounts must not receive postings.'
    WHEN 'payroll_mapping_wrong_account_type' THEN
      'Payroll mapping points at an account whose type is not allowed for this setting (see payroll_account_role_policy).'
    WHEN 'payroll_payable_mapped_to_generic_ap' THEN
      'Payroll payable is folded into Accounts Payable. Statutory and net-pay obligations should each have a dedicated payable account so AP aging and statutory remittance reports stay accurate.'
    WHEN 'payroll_mapping_denied_detail_type' THEN
      'Payroll mapping points at an account whose detail_type is explicitly denied for this setting (see payroll_account_role_policy.denied_detail_types).'
  END AS finding_detail
FROM violations
WHERE violation_code IS NOT NULL;

GRANT SELECT ON public.payroll_mapping_findings TO authenticated;

COMMENT ON VIEW public.payroll_mapping_findings IS
  'Phase 3: single-source-of-truth view. Reads payroll_account_role_policy + checks the same invariants enforced by _payroll_assert_mapping_role and trg_enforce_payroll_je_account_class. Do NOT re-introduce a parallel hardcoded role matrix here — the no-hardcoded-payroll-role-matrix arch test will fail the build.';
