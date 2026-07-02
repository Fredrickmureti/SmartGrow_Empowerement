
-- ============================================================================
-- Phase 4: Payroll Batch reporting views
-- ============================================================================

CREATE OR REPLACE VIEW public.v_payroll_batch_register
WITH (security_invoker = true)
AS
SELECT
  b.id                            AS batch_id,
  b.batch_number,
  b.organization_id,
  b.business_id,
  b.pay_schedule_id,
  b.period_start                  AS batch_period_start,
  b.period_end                    AS batch_period_end,
  b.status                        AS batch_status,
  b.run_type                      AS batch_run_type,
  b.country_code,
  r.id                            AS run_id,
  r.payroll_number,
  r.status                        AS run_status,
  r.run_type                      AS run_type,
  r.pay_period_start,
  r.pay_period_end,
  r.payment_date,
  r.employee_count,
  COALESCE(r.total_gross, 0)                  AS total_gross,
  COALESCE(r.total_net, 0)                    AS total_net,
  COALESCE(r.total_other_deductions, 0)       AS total_other_deductions,
  COALESCE(r.total_employer_contributions, 0) AS total_employer_contributions,
  r.is_reversal,
  r.original_run_id,
  r.reversed_at
FROM public.payroll_run_groups b
JOIN public.payroll_runs r ON r.group_id = b.id;

GRANT SELECT ON public.v_payroll_batch_register TO authenticated;

-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_payroll_period_consolidation
WITH (security_invoker = true)
AS
SELECT
  b.organization_id,
  b.business_id,
  b.period_start,
  b.period_end,
  COUNT(DISTINCT b.id) FILTER (WHERE b.status NOT IN ('cancelled','reversed')) AS batch_count,
  COUNT(DISTINCT r.id) FILTER (WHERE r.status IS DISTINCT FROM 'reversed')     AS run_count,
  COALESCE(SUM(r.employee_count)                  FILTER (WHERE r.status IS DISTINCT FROM 'reversed'), 0) AS headcount,
  COALESCE(SUM(r.total_gross)                     FILTER (WHERE r.status IS DISTINCT FROM 'reversed'), 0) AS total_gross,
  COALESCE(SUM(r.total_net)                       FILTER (WHERE r.status IS DISTINCT FROM 'reversed'), 0) AS total_net,
  COALESCE(SUM(r.total_other_deductions)          FILTER (WHERE r.status IS DISTINCT FROM 'reversed'), 0) AS total_other_deductions,
  COALESCE(SUM(r.total_employer_contributions)    FILTER (WHERE r.status IS DISTINCT FROM 'reversed'), 0) AS total_employer_contributions,
  jsonb_agg(DISTINCT jsonb_build_object(
    'batch_id',     b.id,
    'batch_number', b.batch_number,
    'run_type',     b.run_type,
    'status',       b.status
  )) FILTER (WHERE b.status NOT IN ('cancelled','reversed')) AS batches
FROM public.payroll_run_groups b
LEFT JOIN public.payroll_runs r ON r.group_id = b.id
GROUP BY b.organization_id, b.business_id, b.period_start, b.period_end;

GRANT SELECT ON public.v_payroll_period_consolidation TO authenticated;
