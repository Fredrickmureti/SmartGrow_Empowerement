-- ============================================================================
-- Phase 3.2 — Payroll Run Population Resolver
-- ----------------------------------------------------------------------------
-- Single, authoritative answer to "which employees does this run pay?".
-- Driven by the per-run-type policy seeded in Phase 3.1
-- (`payroll_run_type_policies` + `payroll_get_run_type_policy`).
--
-- Inputs are deliberately *intent* (period window, run_type, parent, hint
-- list) — the function applies every cross-cutting eligibility rule itself
-- so callers (compute-payroll, the create-run dialog, future RPCs) cannot
-- diverge.
--
-- This function is read-only; it never writes payroll state.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.payroll_resolve_run_population(
  p_org_id                 uuid,
  p_business_id            uuid,
  p_period_start           date,
  p_period_end             date,
  p_run_type               text,
  p_country_code           text   DEFAULT NULL,
  p_parent_run_id          uuid   DEFAULT NULL,
  p_explicit_employee_ids  uuid[] DEFAULT NULL
)
RETURNS TABLE (
  employee_id        uuid,
  included           boolean,
  inclusion_reason   text,
  blockers           jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy   jsonb;
  v_source   text;
  v_requires_parent boolean;
BEGIN
  IF p_org_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_run_type IS NULL THEN
    RAISE EXCEPTION 'payroll_resolve_run_population: org/period/run_type are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_period_start > p_period_end THEN
    RAISE EXCEPTION 'payroll_resolve_run_population: period_start > period_end'
      USING ERRCODE = '22023';
  END IF;

  -- ── Resolve the run-type policy. Single source of truth. ──
  v_policy := public.payroll_get_run_type_policy(p_country_code, p_run_type);
  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'payroll_resolve_run_population: unknown run_type %', p_run_type
      USING ERRCODE = '22023';
  END IF;

  v_source          := COALESCE(v_policy->>'population_source', 'active_in_period');
  v_requires_parent := COALESCE((v_policy->>'requires_parent_run')::boolean, false);

  IF v_requires_parent AND p_parent_run_id IS NULL THEN
    RAISE EXCEPTION
      'payroll_resolve_run_population: run_type % requires parent_run_id', p_run_type
      USING ERRCODE = '22023', HINT = 'PARENT_RUN_REQUIRED';
  END IF;

  -- ── Materialize the candidate set per population_source. ──
  RETURN QUERY
  WITH base_active AS (
    -- "active in period" — used by both 'active_in_period' and as the
    -- eligibility check for 'explicit'. An employee is active in the period
    -- when they are not yet terminated by period_start AND they were hired
    -- by period_end.
    SELECT e.id AS employee_id
      FROM public.employees e
     WHERE e.organization_id = p_org_id
       AND (p_business_id IS NULL OR e.business_id = p_business_id)
       AND e.is_active = true
       AND (e.hire_date IS NULL OR e.hire_date <= p_period_end)
       AND (e.termination_date IS NULL OR e.termination_date >= p_period_start)
  ),
  base_terminating AS (
    -- Employees terminating *inside* the window OR carrying a pending
    -- termination payout that has not yet been consumed by a run.
    SELECT e.id AS employee_id
      FROM public.employees e
     WHERE e.organization_id = p_org_id
       AND (p_business_id IS NULL OR e.business_id = p_business_id)
       AND (
         (e.termination_date BETWEEN p_period_start AND p_period_end)
         OR EXISTS (
           SELECT 1
             FROM public.pending_termination_payouts p
            WHERE p.employee_id = e.id
              AND p.organization_id = p_org_id
              AND p.status = 'pending'
              AND p.consumed_run_id IS NULL
         )
       )
  ),
  base_parent AS (
    SELECT DISTINCT ps.employee_id
      FROM public.payslips ps
     WHERE p_parent_run_id IS NOT NULL
       AND ps.payroll_run_id = p_parent_run_id
       AND ps.organization_id = p_org_id
  ),
  base_explicit AS (
    SELECT DISTINCT unnest_id AS employee_id
      FROM unnest(COALESCE(p_explicit_employee_ids, ARRAY[]::uuid[])) AS unnest_id
  ),
  candidates AS (
    SELECT b.employee_id,
           CASE v_source
             WHEN 'active_in_period'      THEN 'active_in_period'
             WHEN 'terminating_in_period' THEN 'terminating_in_period'
             WHEN 'parent_run'            THEN 'parent_run_member'
             WHEN 'explicit'              THEN 'explicit_caller_selection'
             ELSE v_source
           END AS inclusion_reason
      FROM (
        SELECT employee_id FROM base_active      WHERE v_source = 'active_in_period'
        UNION
        SELECT employee_id FROM base_terminating WHERE v_source = 'terminating_in_period'
        UNION
        SELECT employee_id FROM base_parent      WHERE v_source = 'parent_run'
        UNION
        SELECT employee_id FROM base_explicit    WHERE v_source = 'explicit'
      ) b
  ),
  -- Cross-cutting blocker #1: "active in period" gate. Applied to every
  -- source EXCEPT 'parent_run' (a correction must be able to reach a since-
  -- terminated employee on the parent run) and 'terminating_in_period' (the
  -- candidate is, by definition, leaving in the window).
  active_gate AS (
    SELECT c.employee_id,
           CASE
             WHEN v_source IN ('parent_run', 'terminating_in_period') THEN false
             WHEN NOT EXISTS (SELECT 1 FROM base_active ba WHERE ba.employee_id = c.employee_id) THEN true
             ELSE false
           END AS blocked
      FROM candidates c
  ),
  -- Cross-cutting blocker #2: same employee already lives in another OPEN
  -- run of the SAME run_type whose period overlaps. We only enforce this for
  -- 'regular' and the additive intents (off_cycle/bonus/commission/13th_month).
  -- Corrections and supplementals are *expected* to coexist with their parent.
  open_run_conflict AS (
    SELECT ps.employee_id, MIN(pr.payroll_number) AS conflicting_run
      FROM public.payslips ps
      JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
     WHERE pr.organization_id = p_org_id
       AND (p_business_id IS NULL OR pr.business_id = p_business_id)
       AND pr.run_type = p_run_type
       AND pr.status NOT IN ('paid', 'reversed', 'cancelled', 'rejected')
       AND COALESCE(pr.is_reversal, false) = false
       AND tstzrange(pr.pay_period_start::timestamptz, (pr.pay_period_end + 1)::timestamptz, '[)')
           && tstzrange(p_period_start::timestamptz, (p_period_end + 1)::timestamptz, '[)')
       AND v_source NOT IN ('parent_run')  -- corrections/supplementals exempt
     GROUP BY ps.employee_id
  )
  SELECT
    c.employee_id,
    NOT (
      COALESCE(ag.blocked, false)
      OR (orc.employee_id IS NOT NULL)
    ) AS included,
    c.inclusion_reason,
    NULLIF(
      jsonb_strip_nulls(jsonb_build_object(
        'NOT_ACTIVE_IN_PERIOD',
          CASE WHEN COALESCE(ag.blocked, false) THEN jsonb_build_object(
            'message', 'Employee has no active employment overlapping the pay window.',
            'remediation', 'employees:edit',
            'employee_id', c.employee_id
          ) END,
        'ALREADY_IN_OPEN_RUN_OF_SAME_TYPE',
          CASE WHEN orc.employee_id IS NOT NULL THEN jsonb_build_object(
            'message', format('Already included in open %s run %s.', p_run_type, orc.conflicting_run),
            'remediation', 'payroll:open_run',
            'conflicting_run', orc.conflicting_run
          ) END
      )),
      '{}'::jsonb
    ) AS blockers
  FROM candidates c
  LEFT JOIN active_gate       ag  ON ag.employee_id  = c.employee_id
  LEFT JOIN open_run_conflict orc ON orc.employee_id = c.employee_id;
END;
$$;

COMMENT ON FUNCTION public.payroll_resolve_run_population(uuid, uuid, date, date, text, text, uuid, uuid[]) IS
'Phase 3.2 — single source of truth for the employee population of a payroll run. Reads the per-run-type policy (Phase 3.1) and applies population_source plus cross-cutting eligibility rules (active-in-period, no concurrent open run of the same type). Read-only.';

REVOKE ALL ON FUNCTION public.payroll_resolve_run_population(uuid, uuid, date, date, text, text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_resolve_run_population(uuid, uuid, date, date, text, text, uuid, uuid[]) TO authenticated, service_role;
