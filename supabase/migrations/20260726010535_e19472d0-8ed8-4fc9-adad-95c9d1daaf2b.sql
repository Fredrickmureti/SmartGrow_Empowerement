-- =========================================================================
-- Payroll readiness ↔ posting parity for loan repayments
-- -------------------------------------------------------------------------
-- Root cause fixed here: payroll_required_gl_mappings_for_run was aggregating
-- payslip_lines by rule_code and demanding a `<rule_code>_payable` mapping
-- for every employee-side deduction. Its filter tried to skip loan lines via
-- `category NOT IN ('earning','loan_repayment')`, but compute-payroll writes
-- loan repayment lines with `category = 'deduction'`. Those lines therefore
-- leaked through and produced phantom keys like `loan_repayment_sal_adv_payable`
-- that no code ever reads — post-payroll-gl posts loan legs through
-- `payroll_loan_repayment_gl_targets`, which resolves the credit leg from
-- `loan_types.gl_receivable_account_id` (fallback: `_loan_resolve_account`
-- with role `loan_receivable`). This function is now aligned with that
-- posting contract.
-- =========================================================================

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
    -- Aggregate every non-earning, non-loan-repayment payslip line by
    -- rule_code. Loan repayment lines are excluded on THREE independent
    -- predicates (category, rule_code prefix, source hints) so any single
    -- future refactor of compute-payroll's line shape cannot silently
    -- reintroduce phantom loan_repayment_*_payable requirements.
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
      AND lower(pl.rule_code) NOT LIKE 'loan_repayment%'
      AND COALESCE(pl.source->>'source', '') <> 'custom_deduction'
      AND COALESCE(pl.source->>'kind', '')   <> 'loan_repayment'
      AND lower(COALESCE(pl.source->'input_ref'->>'code','')) NOT LIKE 'loan_repayment%'
    GROUP BY pl.rule_code
  ),
  -- Loan-side requirements — the mappings loans ACTUALLY need. One row per
  -- distinct loan_type used in this run's repayment ledger; asks for the
  -- receivable (always) and interest income (when the type charges interest).
  loan_types_used AS (
    SELECT DISTINCT lt.id, lt.name, lt.gl_receivable_account_id,
           lt.interest_income_account_id, COALESCE(lt.interest_rate, 0) AS interest_rate
      FROM public.loan_repayments lr
      JOIN public.employee_loans l  ON l.id  = lr.loan_id
      JOIN public.loan_types      lt ON lt.id = l.loan_type_id
     WHERE lr.payroll_run_id = p_run_id
       AND lr.reversal_of_id IS NULL
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
    -- Loan-side virtual keys. `setting_key` uses a `loan_type:<id>:<role>`
    -- shape so the UI can route these to Loan Types settings rather than the
    -- generic default_account_settings mapping surface.
    UNION ALL
    SELECT 'loan_type:' || ltu.id::text || ':receivable',
           ltu.name || ' — Receivable',
           NULL, 'loan_receivable', 'asset'
    FROM loan_types_used ltu
    UNION ALL
    SELECT 'loan_type:' || ltu.id::text || ':interest_income',
           ltu.name || ' — Interest Income',
           NULL, 'interest_income', 'income'
    FROM loan_types_used ltu WHERE ltu.interest_rate > 0
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (n.setting_key)
      n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type
    FROM needed n
    ORDER BY n.setting_key,
             CASE n.kind WHEN 'core' THEN 0
                         WHEN 'employee_payable' THEN 1
                         WHEN 'employer_expense' THEN 2
                         WHEN 'loan_receivable' THEN 4
                         WHEN 'interest_income'  THEN 5
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
  -- Loan-type mapping status. A loan_receivable / interest_income row is
  -- "mapped" iff the loan_types column is populated. The suggested account
  -- (for the UI to display) is the currently-mapped one.
  loan_mapping_status AS (
    SELECT 'loan_type:' || id::text || ':receivable' AS setting_key,
           gl_receivable_account_id AS account_id
      FROM loan_types_used
    UNION ALL
    SELECT 'loan_type:' || id::text || ':interest_income',
           interest_income_account_id
      FROM loan_types_used WHERE interest_rate > 0
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
            WHEN n.setting_key = 'salary_expense'
                 OR n.kind = 'employer_expense'
            THEN CASE WHEN public._payroll_is_cogs_account(c.id) THEN 9 ELSE 0 END
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
    JOIN candidates c ON c.account_type = n.required_account_type
  ),
  suggested AS (
    SELECT r.setting_key, r.account_id
      FROM ranked r WHERE r.rn = 1
  )
  SELECT
    n.setting_key,
    n.label,
    n.rule_code,
    n.kind,
    n.required_account_type,
    -- is_mapped: loan-side rows read from loan_types; everything else from
    -- the default_account_settings resolver.
    CASE
      WHEN n.setting_key LIKE 'loan_type:%'
        THEN (SELECT lms.account_id FROM loan_mapping_status lms
               WHERE lms.setting_key = n.setting_key) IS NOT NULL
      ELSE (SELECT em.account_id FROM effective_mappings em
             WHERE em.setting_key = n.setting_key) IS NOT NULL
    END AS is_mapped,
    -- suggested_account_id: loan-side rows suggest whatever is currently
    -- mapped in loan_types; other rows fall back to the heuristic ranker.
    CASE
      WHEN n.setting_key LIKE 'loan_type:%'
        THEN (SELECT lms.account_id FROM loan_mapping_status lms
               WHERE lms.setting_key = n.setting_key)
      ELSE (SELECT s.account_id FROM suggested s
             WHERE s.setting_key = n.setting_key)
    END AS suggested_account_id,
    (SELECT c.code || ' — ' || c.name
       FROM candidates c
      WHERE c.id = CASE
        WHEN n.setting_key LIKE 'loan_type:%'
          THEN (SELECT lms.account_id FROM loan_mapping_status lms
                 WHERE lms.setting_key = n.setting_key)
        ELSE (SELECT s.account_id FROM suggested s
               WHERE s.setting_key = n.setting_key)
      END
    ) AS suggested_account_label
  FROM needed_dedup n;
END
$function$;

-- =========================================================================
-- One-shot cleanup: drop existing phantom blocker rows so runs currently
-- stuck in the contradictory "missing GL mapping but everything configured"
-- state unblock on next readiness re-evaluation. Scoped narrowly: only
-- GL_MAPPING_MISSING blockers whose setting_key matches the loan-repayment
-- payable / employer-expense shape.
-- =========================================================================
DELETE FROM public.payroll_run_issues
 WHERE code = 'GL_MAPPING_MISSING'
   AND severity = 'blocker'
   AND (
     (details->>'setting_key') ~ '^loan_repayment_.*_(payable|employer_expense)$'
   );
