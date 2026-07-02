
-- =====================================================================
-- 1. Headcount snapshot (current)
-- =====================================================================
CREATE OR REPLACE VIEW public.v_hr_headcount_snapshot
WITH (security_invoker = true) AS
SELECT
  e.organization_id,
  e.business_id,
  e.branch_id,
  e.department_id,
  d.name                                          AS department_name,
  COUNT(*)                                        AS total_count,
  COUNT(*) FILTER (WHERE e.is_active)             AS active_count,
  COUNT(*) FILTER (WHERE NOT e.is_active)         AS inactive_count,
  COUNT(*) FILTER (WHERE e.employment_type = 'full_time' AND e.is_active) AS full_time_count,
  COUNT(*) FILTER (WHERE e.employment_type = 'part_time' AND e.is_active) AS part_time_count,
  COUNT(*) FILTER (WHERE e.employment_type = 'contract'  AND e.is_active) AS contract_count,
  CURRENT_DATE                                    AS snapshot_date
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
GROUP BY e.organization_id, e.business_id, e.branch_id, e.department_id, d.name;

GRANT SELECT ON public.v_hr_headcount_snapshot TO authenticated, service_role;

-- =====================================================================
-- 2. Rolling 12-month turnover
-- =====================================================================
CREATE OR REPLACE VIEW public.v_hr_turnover_rolling_12m
WITH (security_invoker = true) AS
WITH window_bounds AS (
  SELECT (CURRENT_DATE - INTERVAL '12 months')::date AS w_start,
         CURRENT_DATE                                AS w_end
),
hires AS (
  SELECT e.organization_id, e.business_id, e.branch_id, e.department_id,
         COUNT(*) AS hires_12m
    FROM public.employees e, window_bounds w
   WHERE e.hire_date BETWEEN w.w_start AND w.w_end
   GROUP BY 1,2,3,4
),
terms AS (
  SELECT e.organization_id, e.business_id, e.branch_id, e.department_id,
         COUNT(*) AS terminations_12m
    FROM public.employees e, window_bounds w
   WHERE e.termination_date BETWEEN w.w_start AND w.w_end
   GROUP BY 1,2,3,4
),
hc AS (
  SELECT e.organization_id, e.business_id, e.branch_id, e.department_id,
         COUNT(*) FILTER (WHERE e.is_active) AS active_now,
         COUNT(*)                            AS total_now
    FROM public.employees e
   GROUP BY 1,2,3,4
)
SELECT
  hc.organization_id, hc.business_id, hc.branch_id, hc.department_id,
  hc.active_now,
  hc.total_now,
  COALESCE(h.hires_12m, 0)        AS hires_12m,
  COALESCE(t.terminations_12m, 0) AS terminations_12m,
  CASE
    WHEN hc.active_now = 0 THEN NULL
    ELSE ROUND(
      (COALESCE(t.terminations_12m, 0)::numeric / NULLIF(hc.active_now, 0)) * 100,
      2)
  END                              AS turnover_pct
FROM hc
LEFT JOIN hires h USING (organization_id, business_id, branch_id, department_id)
LEFT JOIN terms t USING (organization_id, business_id, branch_id, department_id);

GRANT SELECT ON public.v_hr_turnover_rolling_12m TO authenticated, service_role;

-- =====================================================================
-- 3. Payroll cost by department (per run)
-- =====================================================================
CREATE OR REPLACE VIEW public.v_payroll_cost_by_department
WITH (security_invoker = true) AS
SELECT
  pr.organization_id,
  pr.business_id,
  pr.id                                AS payroll_run_id,
  pr.payroll_number,
  pr.pay_period_start,
  pr.pay_period_end,
  pr.status                            AS run_status,
  pr.currency,
  e.department_id,
  d.name                               AS department_name,
  COUNT(DISTINCT ps.employee_id)       AS employee_count,
  COALESCE(SUM(ps.gross_pay), 0)       AS total_gross,
  COALESCE(SUM(ps.total_deductions),0) AS total_deductions,
  COALESCE(SUM(ps.net_pay), 0)         AS total_net
FROM public.payroll_runs pr
JOIN public.payslips ps   ON ps.payroll_run_id = pr.id
JOIN public.employees e   ON e.id = ps.employee_id
LEFT JOIN public.departments d ON d.id = e.department_id
WHERE COALESCE(pr.is_reversal, false) = false
GROUP BY pr.organization_id, pr.business_id, pr.id, pr.payroll_number,
         pr.pay_period_start, pr.pay_period_end, pr.status, pr.currency,
         e.department_id, d.name;

GRANT SELECT ON public.v_payroll_cost_by_department TO authenticated, service_role;

-- =====================================================================
-- 4. Open leave liability
-- =====================================================================
CREATE OR REPLACE VIEW public.v_leave_liability_open
WITH (security_invoker = true) AS
WITH active_contract AS (
  SELECT DISTINCT ON (ec.employee_id)
    ec.employee_id,
    ec.wage,
    ec.housing_allowance,
    ec.transport_allowance
  FROM public.employee_contracts ec
  WHERE ec.status IN ('new','running')
    AND ec.start_date <= CURRENT_DATE
    AND (ec.end_date IS NULL OR ec.end_date >= CURRENT_DATE)
  ORDER BY ec.employee_id, ec.start_date DESC
)
SELECT
  la.organization_id,
  la.business_id,
  la.employee_id,
  e.department_id,
  la.leave_type_id,
  lt.name                                                              AS leave_type_name,
  lt.is_paid,
  la.year,
  COALESCE(SUM(la.days_allocated), 0)                                  AS days_allocated,
  COALESCE(SUM(la.days_used), 0)                                       AS days_used,
  COALESCE(SUM(la.days_pending), 0)                                    AS days_pending,
  GREATEST(
    0,
    COALESCE(SUM(la.days_allocated),0)
      - COALESCE(SUM(la.days_used),0)
      - COALESCE(SUM(la.days_pending),0)
  )                                                                    AS days_open,
  -- Indicative monetary liability: open days × daily rate of active contract.
  -- Daily rate = (wage + housing + transport) / 22.
  ROUND(
    GREATEST(
      0,
      COALESCE(SUM(la.days_allocated),0)
        - COALESCE(SUM(la.days_used),0)
        - COALESCE(SUM(la.days_pending),0)
    )
    * COALESCE(
        (ac.wage + COALESCE(ac.housing_allowance,0) + COALESCE(ac.transport_allowance,0)) / 22.0,
        0)
    * CASE WHEN COALESCE(lt.is_paid, true) THEN 1 ELSE 0 END
  , 2)                                                                  AS liability_amount
FROM public.leave_allocations la
JOIN public.leave_types lt ON lt.id = la.leave_type_id
JOIN public.employees e    ON e.id  = la.employee_id
LEFT JOIN active_contract ac ON ac.employee_id = la.employee_id
WHERE la.year >= EXTRACT(YEAR FROM CURRENT_DATE) - 1
GROUP BY la.organization_id, la.business_id, la.employee_id, e.department_id,
         la.leave_type_id, lt.name, lt.is_paid, la.year,
         ac.wage, ac.housing_allowance, ac.transport_allowance;

GRANT SELECT ON public.v_leave_liability_open TO authenticated, service_role;
