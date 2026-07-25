-- ADR 0091 (Phase 3, payroll leg): payroll-deducted loan repayments must
-- relieve the loan receivable, not a payable clearing liability.

CREATE OR REPLACE FUNCTION public.payroll_loan_repayment_gl_targets(p_run_id uuid)
RETURNS TABLE(
  loan_id uuid,
  loan_number text,
  receivable_account_id uuid,
  interest_account_id uuid,
  principal_amount numeric,
  interest_amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run   public.payroll_runs%ROWTYPE;
  r       record;
  v_p     numeric;
  v_i     numeric;
  v_recv  uuid;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.is_org_member(auth.uid(), v_run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to inspect this payroll run' USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT lr.loan_id                    AS lid,
           l.loan_number                 AS lnum,
           l.organization_id             AS org,
           l.business_id                 AS biz,
           lt.gl_receivable_account_id   AS lt_recv,
           lt.interest_income_account_id AS lt_int,
           SUM(lr.amount)                AS amount
      FROM public.loan_repayments lr
      JOIN public.employee_loans l ON l.id = lr.loan_id
      LEFT JOIN public.loan_types lt ON lt.id = l.loan_type_id
     WHERE lr.payroll_run_id = p_run_id
       AND lr.reversal_of_id IS NULL
     GROUP BY 1,2,3,4,5,6
  LOOP
    IF COALESCE(r.amount, 0) <= 0 THEN
      CONTINUE;
    END IF;

    -- Principal / interest split on the same pro-rata basis the manual
    -- repayment RPC uses, so both legs agree with the integrity check.
    SELECT o_principal, o_interest INTO v_p, v_i
      FROM public._loan_split_repayment(r.lid, r.amount);

    v_recv := COALESCE(
      r.lt_recv,
      public._loan_resolve_account(r.org, r.biz, NULL, 'loan_receivable', NULL)
    );

    -- No interest account mapped → recover the whole instalment as principal
    -- (mirrors _loan_split_repayment's fallback contract).
    IF r.lt_int IS NULL THEN
      v_p := COALESCE(v_p, 0) + COALESCE(v_i, 0);
      v_i := 0;
    END IF;

    RETURN QUERY SELECT
      r.lid,
      r.lnum,
      v_recv,
      r.lt_int,
      ROUND(COALESCE(v_p, 0), 2),
      ROUND(COALESCE(v_i, 0), 2);
  END LOOP;
END
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_loan_repayment_gl_targets(uuid) TO authenticated, service_role;

-- Loan repayment lines no longer need a `<rule_code>_payable` liability
-- mapping: they post against the loan receivable / interest income accounts
-- resolved above. Keeping the requirement would block posting on a mapping
-- the engine never uses.
CREATE OR REPLACE FUNCTION public.payroll_required_gl_mappings_for_run(p_run_id uuid)
 RETURNS TABLE(setting_key text, label text, rule_code text, kind text, required_account_type text, is_mapped boolean, suggested_account_id uuid, suggested_account_label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'benefit_recovery','benefit'
      ) AND COALESCE(pl.employee_amount,0) > 0) AS has_employee,
      BOOL_OR(pl.category::text IN (
        'employer_contribution','statutory_employer'
      ) AND COALESCE(pl.employer_amount,0) > 0) AS has_employer
    FROM public.payslip_lines pl
    WHERE pl.payroll_run_id = p_run_id
      AND pl.rule_code IS NOT NULL
      AND pl.category::text NOT IN ('earning','loan_repayment')
      AND COALESCE(pl.source->>'source', '') <> 'custom_deduction'
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
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type,
           COALESCE(a.detail_type, '') AS detail_type
    FROM public.accounts a
    WHERE a.organization_id = v_run.organization_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND (v_run.business_id IS NULL
           OR a.business_id IS NULL
           OR a.business_id = v_run.business_id)
  ),
  ranked AS (
    SELECT
      n.setting_key,
      c.id AS account_id,
      ROW_NUMBER() OVER (
        PARTITION BY n.setting_key
        ORDER BY
          CASE
            WHEN n.setting_key IN ('salary_expense')
                 OR n.kind = 'employer_expense'
            THEN CASE
              WHEN public._payroll_is_cogs_account(c.id) THEN 9
              ELSE 0
            END
            ELSE 0
          END,
          CASE
            WHEN n.rule_code IS NOT NULL
                 AND (lower(c.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                      OR lower(c.code) ILIKE '%'||lower(n.rule_code)||'%')
            THEN 0 ELSE 1
          END,
          CASE
            WHEN lower(c.name) ILIKE '%'||lower(replace(n.setting_key,'_',' '))||'%'
            THEN 0 ELSE 1
          END,
          c.code
      ) AS rn
    FROM needed_dedup n
    JOIN candidates c
      ON c.account_type = n.required_account_type
  )
  SELECT
    n.setting_key,
    n.label,
    n.rule_code,
    n.kind,
    n.required_account_type,
    (em.account_id IS NOT NULL) AS is_mapped,
    r.account_id AS suggested_account_id,
    (SELECT a.code || ' · ' || a.name FROM public.accounts a WHERE a.id = r.account_id) AS suggested_account_label
  FROM needed_dedup n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN ranked r ON r.setting_key = n.setting_key AND r.rn = 1
  ORDER BY
    CASE n.kind WHEN 'core' THEN 0 WHEN 'employee_payable' THEN 1
                WHEN 'employer_expense' THEN 2 ELSE 3 END,
    n.setting_key;
END
$function$;