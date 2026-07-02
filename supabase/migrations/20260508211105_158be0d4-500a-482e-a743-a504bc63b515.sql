CREATE OR REPLACE FUNCTION public.payroll_required_gl_mappings_for_run(p_run_id uuid)
RETURNS TABLE(
  setting_key text,
  label text,
  rule_code text,
  kind text,
  required_account_type text,
  is_mapped boolean,
  suggested_account_id uuid,
  suggested_account_label text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.is_org_member(auth.uid(), v_run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to inspect this payroll run' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      pl.rule_code,
      MAX(COALESCE(pl.label, pl.rule_code)) AS label,
      BOOL_OR(pl.category::text IN (
        'deduction','statutory_employee','tax',
        'loan_repayment','benefit_recovery','benefit'
      ) AND COALESCE(pl.employee_amount,0) > 0) AS has_employee,
      BOOL_OR(pl.category::text IN (
        'employer_contribution','statutory_employer'
      ) AND COALESCE(pl.employer_amount,0) > 0) AS has_employer
    FROM public.payslip_lines pl
    WHERE pl.payroll_run_id = p_run_id
      AND pl.rule_code IS NOT NULL
      AND pl.category::text <> 'earning'
    GROUP BY pl.rule_code
  ),
  needed AS (
    SELECT 'salary_expense'::text AS setting_key, 'Salary Expense'::text AS label,
           NULL::text AS rule_code, 'core'::text AS kind, 'expense'::text AS required_account_type
    UNION ALL
    SELECT 'net_salary_payable', 'Net Salary Payable', NULL, 'core', 'liability'
    UNION ALL
    SELECT a.rule_code || '_payable',
           COALESCE(a.label, a.rule_code) || ' — Payable',
           a.rule_code, 'employee_payable', 'liability'
    FROM agg a WHERE a.has_employee
    UNION ALL
    SELECT a.rule_code || '_employer_expense',
           COALESCE(a.label, a.rule_code) || ' — Employer Expense',
           a.rule_code, 'employer_expense', 'expense'
    FROM agg a WHERE a.has_employer
    UNION ALL
    SELECT a.rule_code || '_payable',
           COALESCE(a.label, a.rule_code) || ' — Payable',
           a.rule_code, 'employer_payable', 'liability'
    FROM agg a WHERE a.has_employer AND NOT a.has_employee
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (n.setting_key)
      n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type
    FROM needed n
    ORDER BY n.setting_key,
             CASE n.kind WHEN 'core' THEN 0
                         WHEN 'employee_payable' THEN 1
                         WHEN 'employer_expense' THEN 2
                         ELSE 3 END
  ),
  effective_mappings AS (
    SELECT DISTINCT ON (das.setting_key)
      das.setting_key, das.account_id
    FROM public.default_account_settings das
    WHERE das.organization_id = v_run.organization_id
      AND (v_run.business_id IS NULL
           OR das.business_id IS NULL
           OR das.business_id = v_run.business_id)
    ORDER BY das.setting_key, (das.business_id IS NOT NULL) DESC
  ),
  candidates AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type
    FROM public.accounts a
    WHERE a.organization_id = v_run.organization_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND (v_run.business_id IS NULL
           OR a.business_id IS NULL
           OR a.business_id = v_run.business_id)
  ),
  ranked AS (
    SELECT n.setting_key, c.id AS account_id,
           ROW_NUMBER() OVER (
             PARTITION BY n.setting_key
             ORDER BY
               CASE WHEN n.rule_code IS NOT NULL
                         AND (lower(c.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                              OR lower(c.code) ILIKE '%'||lower(n.rule_code)||'%')
                    THEN 0
                    WHEN lower(c.name) ILIKE '%'||lower(replace(n.setting_key,'_',' '))||'%'
                    THEN 1
                    ELSE 2
               END,
               c.code
           ) AS rn
    FROM needed_dedup n
    JOIN candidates c ON c.account_type = n.required_account_type
  ),
  suggestions AS (
    SELECT r.setting_key, r.account_id FROM ranked r WHERE r.rn = 1
  )
  SELECT
    n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
    (em.account_id IS NOT NULL) AS is_mapped,
    CASE WHEN em.account_id IS NULL THEN s.account_id END AS suggested_account_id,
    CASE WHEN em.account_id IS NULL THEN
      (SELECT a.code || ' — ' || a.name FROM public.accounts a WHERE a.id = s.account_id)
    END AS suggested_account_label
  FROM needed_dedup n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN suggestions s ON s.setting_key = n.setting_key
  ORDER BY n.kind, n.setting_key;
END;
$$;