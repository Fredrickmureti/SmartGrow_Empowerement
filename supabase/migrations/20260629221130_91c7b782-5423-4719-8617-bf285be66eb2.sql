
-- ============================================================================
-- Phase 6: Retire legacy run-group surface
-- ============================================================================

-- Recreate the view without totals_json dependency (it does not reference it,
-- but rebuilding here keeps the column drop safe across environments).
DROP VIEW IF EXISTS public.v_payroll_batches;

ALTER TABLE public.payroll_run_groups
  DROP COLUMN IF EXISTS totals_json;

-- Rebuild v_payroll_batches (server-computed totals, matches Phase 1 shape).
CREATE OR REPLACE VIEW public.v_payroll_batches
WITH (security_invoker = true)
AS
SELECT
  b.id,
  b.organization_id,
  b.business_id,
  b.pay_schedule_id,
  b.country_code,
  b.name,
  b.batch_number,
  b.idempotency_key,
  b.run_type,
  b.parent_batch_id,
  b.period_start,
  b.period_end,
  b.status,
  b.notes,
  b.locked_at,
  b.approved_by, b.approved_at,
  b.posted_by,   b.posted_at,   b.consolidated_journal_entry_id,
  b.paid_by,     b.paid_at,     b.payment_batch_id,
  b.closed_at,
  b.reversal_batch_id,
  b.readiness_snapshot_id,
  b.created_by,
  b.created_at,
  b.updated_at,
  COALESCE(agg.child_run_count, 0)              AS child_run_count,
  COALESCE(agg.headcount, 0)                    AS headcount,
  COALESCE(agg.total_gross, 0)                  AS total_gross,
  COALESCE(agg.total_net, 0)                    AS total_net,
  COALESCE(agg.total_employer_contributions, 0) AS total_employer_contributions
FROM public.payroll_run_groups b
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int                                  AS child_run_count,
    COALESCE(SUM(r.employee_count), 0)::int        AS headcount,
    COALESCE(SUM(r.total_gross), 0)::numeric       AS total_gross,
    COALESCE(SUM(r.total_net), 0)::numeric         AS total_net,
    COALESCE(SUM(r.total_employer_contributions), 0)::numeric AS total_employer_contributions
  FROM public.payroll_runs r
  WHERE r.group_id = b.id
) agg ON TRUE;

GRANT SELECT ON public.v_payroll_batches TO authenticated;

-- Retire 'group_child' from the run_type validator. Batch membership is now
-- expressed by payroll_runs.group_id IS NOT NULL alone.
CREATE OR REPLACE FUNCTION public.validate_payroll_run_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_type NOT IN ('regular','off_cycle','final_settlement') THEN
    RAISE EXCEPTION 'invalid run_type: %', NEW.run_type;
  END IF;
  IF NEW.is_final_settlement AND NEW.final_settlement_employee_id IS NULL THEN
    RAISE EXCEPTION 'final_settlement_employee_id required when is_final_settlement=true';
  END IF;
  RETURN NEW;
END
$$;
