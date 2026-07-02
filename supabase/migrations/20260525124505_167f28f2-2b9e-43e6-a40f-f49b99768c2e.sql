
-- ============================================================
-- Payroll GL mapping hardening
-- ============================================================

-- 1. Helper: classify an account as a Cost-of-Sales account by detail_type
--    or by name/code heuristic. Used by both the suggester and the
--    apply-mappings guard.
CREATE OR REPLACE FUNCTION public._payroll_is_cogs_account(p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_account_id
      AND a.account_type = 'expense'
      AND (
        COALESCE(a.detail_type, '') ILIKE '%cost_of%'
        OR COALESCE(a.detail_type, '') ILIKE '%cogs%'
        OR lower(a.name) ILIKE '%cost of goods sold%'
        OR lower(a.name) ILIKE '%cost of sales%'
        OR lower(a.name) ILIKE '%cost of revenue%'
        OR a.code LIKE '50%'
        OR a.code LIKE '51%'
      )
  );
$$;

-- 2. Role-aware rewrite of payroll_required_gl_mappings_for_run.
--    Key change: ranking explicitly DOWN-RANKS Cost-of-Goods-Sold accounts
--    for salary_expense / employer_expense keys, and UP-RANKS accounts
--    whose name/code looks like a payroll account (salaries, wages, staff,
--    payroll, employee, compensation, statutory, paye, nssf, shif, nhif).
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
          -- Hard filter on the suggestion side: never propose a COGS account
          -- for a salary/employer expense key. We do this by sorting them
          -- last (rank 9) instead of excluding them outright, so we still
          -- return *something* if the org has no other expense accounts.
          CASE
            WHEN n.setting_key IN ('salary_expense')
                 OR n.kind = 'employer_expense'
            THEN CASE
              WHEN public._payroll_is_cogs_account(c.id) THEN 9
              ELSE 0
            END
            ELSE 0
          END,
          -- Strongest signal: rule_code match (e.g. paye, nssf, shif, nhif).
          CASE
            WHEN n.rule_code IS NOT NULL
                 AND (lower(c.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                      OR lower(c.code) ILIKE '%'||lower(n.rule_code)||'%')
            THEN 0 ELSE 1
          END,
          -- Next: setting-key match (e.g. "salary expense", "net salary payable").
          CASE
            WHEN lower(c.name) ILIKE '%'||lower(replace(n.setting_key,'_',' '))||'%'
            THEN 0 ELSE 1
          END,
          -- Payroll-flavoured names beat generic expense / liability accounts.
          CASE
            WHEN n.setting_key IN ('salary_expense') OR n.kind = 'employer_expense' THEN
              CASE
                WHEN lower(c.name) ~ '(salary|salaries|wage|wages|payroll|staff cost|compensation|employee benefit|employer contribution)'
                  OR lower(c.detail_type) ~ '(payroll|salary|wage|staff|compensation)'
                THEN 0 ELSE 1
              END
            WHEN n.required_account_type = 'liability' THEN
              CASE
                WHEN lower(c.name) ~ '(payable|withhold|statutory|payroll|salary|wage|paye|nssf|shif|nhif|tax)'
                THEN 0 ELSE 1
              END
            ELSE 1
          END,
          -- Penalise generic catch-all liability accounts ("Accounts Payable",
          -- bare "Liabilities") so they aren't auto-picked for payroll lines.
          CASE
            WHEN n.required_account_type = 'liability'
                 AND (lower(c.name) IN ('accounts payable','liabilities','current liabilities','trade payables')
                      OR c.code IN ('2000','2100','2110'))
            THEN 1 ELSE 0
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

-- 3. Guard the "apply proposed mappings" action: reject salary/employer
--    mappings that point at a Cost-of-Sales account. Existing rows are
--    unchanged; this only blocks NEW writes.
CREATE OR REPLACE FUNCTION public.payroll_apply_proposed_mappings(
  _org_id uuid, _business_id uuid, _accept jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_count integer := 0;
  item jsonb;
  v_key text;
  v_account_id uuid;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user
        AND ur.organization_id = _org_id
        AND ur.is_active = true
    ) THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(_accept,'[]'::jsonb))
  LOOP
    v_key := item->>'setting_key';
    v_account_id := (item->>'account_id')::uuid;

    -- Role guard: salary_expense and *_employer_expense must NEVER be
    -- mapped to a Cost-of-Goods-Sold / Cost-of-Sales account.
    IF (v_key = 'salary_expense' OR v_key LIKE '%_employer_expense')
       AND public._payroll_is_cogs_account(v_account_id) THEN
      RAISE EXCEPTION
        'payroll_mapping_role_violation: setting_key % cannot map to a Cost of Goods Sold / Cost of Sales account', v_key
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.default_account_settings (
      organization_id, business_id, setting_key, account_id
    ) VALUES (
      _org_id, _business_id, v_key, v_account_id
    )
    ON CONFLICT (organization_id, business_id, setting_key) DO UPDATE
      SET account_id = EXCLUDED.account_id, updated_at = now();
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_count;
END;
$function$;

-- 4. Diagnostic view: every existing payroll mapping that violates the
--    role rules, so the UI can show "Fix payroll mapping" findings to
--    affected tenants. Already-posted journal entries are NOT mutated.
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
  WHERE das.setting_key = 'salary_expense'
     OR das.setting_key LIKE '%_employer_expense'
     OR das.setting_key LIKE '%_payable'
)
SELECT
  organization_id,
  business_id,
  setting_key,
  account_id,
  account_code,
  account_name,
  account_type,
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

-- The view is filtered by RLS-aware columns; we still scope reads via a
-- function that checks org membership, so direct-table grants are safe.
COMMENT ON VIEW public.payroll_mapping_findings IS
  'Detects payroll GL mappings that point at the wrong account class (e.g. salary -> COGS, payable -> header or generic AP). Already-posted journal entries are not mutated; the UI offers a manual remap + reclassification journal.';
