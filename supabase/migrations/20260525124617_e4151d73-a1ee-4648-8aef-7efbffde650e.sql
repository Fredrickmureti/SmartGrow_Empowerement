
CREATE OR REPLACE VIEW public.payroll_mapping_findings AS
WITH bad AS (
  SELECT
    das.organization_id,
    das.business_id,
    das.setting_key,
    a.id   AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type::text AS account_type,
    CASE
      WHEN (das.setting_key = 'salary_expense'
            OR das.setting_key LIKE '%_employer_expense')
           AND public._payroll_is_cogs_account(a.id)
        THEN 'salary_expense_mapped_to_cogs'
      WHEN das.setting_key LIKE '%_payable' AND COALESCE(a.is_header, false)
        THEN 'payroll_payable_mapped_to_header'
      WHEN das.setting_key LIKE '%_payable'
           AND (lower(a.name) IN ('accounts payable','liabilities','current liabilities','trade payables')
                OR a.code IN ('2000','2100','2110'))
        THEN 'payroll_payable_mapped_to_generic_ap'
      ELSE NULL
    END AS violation_code
  FROM public.default_account_settings das
  JOIN public.accounts a ON a.id = das.account_id
  -- Exclude non-payroll canonical AP/AR settings.
  WHERE das.setting_key NOT IN ('accounts_payable','accounts_receivable')
    AND (
      das.setting_key = 'salary_expense'
      OR das.setting_key LIKE '%_employer_expense'
      OR das.setting_key LIKE '%_payable'
    )
)
SELECT
  organization_id, business_id, setting_key,
  account_id, account_code, account_name, account_type,
  violation_code,
  CASE violation_code
    WHEN 'salary_expense_mapped_to_cogs' THEN 'critical'
    WHEN 'payroll_payable_mapped_to_header' THEN 'critical'
    WHEN 'payroll_payable_mapped_to_generic_ap' THEN 'warning'
  END AS severity,
  CASE violation_code
    WHEN 'salary_expense_mapped_to_cogs' THEN
      'Payroll salary / employer-expense is posted to a Cost of Goods Sold account. This distorts gross margin and COGS reports. Remap to a Payroll Expenses / Salaries & Wages account.'
    WHEN 'payroll_payable_mapped_to_header' THEN
      'Payroll payable is mapped to a header / parent account. Header accounts must not receive postings.'
    WHEN 'payroll_payable_mapped_to_generic_ap' THEN
      'Payroll payable is folded into Accounts Payable. Statutory and net-pay obligations should each have a dedicated payable account so AP aging and statutory remittance reports stay accurate.'
  END AS finding_detail
FROM bad
WHERE violation_code IS NOT NULL;

GRANT SELECT ON public.payroll_mapping_findings TO authenticated;
