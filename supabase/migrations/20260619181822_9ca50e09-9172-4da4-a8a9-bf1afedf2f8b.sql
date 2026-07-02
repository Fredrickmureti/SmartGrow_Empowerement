
-- =========================================================================
-- Wave 7: Post-payroll compliance — gov filing lifecycle + monthly breakdown
-- =========================================================================

-- P1.1: Monthly breakdown RPC for certificate `monthly_breakdown` section
-- (KE P9 and equivalents). Aggregates payslip_lines per (month, rule_code)
-- for a single employee across a fiscal year.
CREATE OR REPLACE FUNCTION public.payroll_employee_monthly_breakdown(
  p_year integer,
  p_employee_id uuid,
  p_rule_codes text[]
)
RETURNS TABLE (
  month_index integer,
  rule_code text,
  category text,
  employee_amount numeric,
  employer_amount numeric,
  taxable_amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXTRACT(MONTH FROM pr.pay_period_end)::int AS month_index,
    pl.rule_code,
    MAX(pl.category) AS category,
    COALESCE(SUM(pl.employee_amount), 0)::numeric AS employee_amount,
    COALESCE(SUM(pl.employer_amount), 0)::numeric AS employer_amount,
    COALESCE(SUM(
      CASE WHEN ps.taxable_income IS NOT NULL
           THEN ps.taxable_income / NULLIF(ps_line_count.cnt, 0)
           ELSE 0 END
    ), 0)::numeric AS taxable_amount
  FROM payslip_lines pl
  JOIN payslips ps ON ps.id = pl.payslip_id
  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::numeric AS cnt
    FROM payslip_lines pl2 WHERE pl2.payslip_id = ps.id
  ) ps_line_count ON true
  WHERE ps.employee_id = p_employee_id
    AND EXTRACT(YEAR FROM pr.pay_period_end)::int = p_year
    AND ps.status IN ('validated', 'paid')
    AND (p_rule_codes IS NULL OR pl.rule_code = ANY(p_rule_codes))
  GROUP BY EXTRACT(MONTH FROM pr.pay_period_end), pl.rule_code
  ORDER BY month_index, rule_code;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[])
  TO authenticated, service_role;

-- =========================================================================
-- P2.1: Structured filing lifecycle on payroll_return_runs
-- =========================================================================
ALTER TABLE public.payroll_return_runs
  ADD COLUMN IF NOT EXISTS gov_file_path text,
  ADD COLUMN IF NOT EXISTS submission_channel text,
  ADD COLUMN IF NOT EXISTS portal_receipt_path text,
  ADD COLUMN IF NOT EXISTS rejection_reasons jsonb,
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

ALTER TABLE public.payroll_return_runs
  DROP CONSTRAINT IF EXISTS payroll_return_runs_submission_channel_check;
ALTER TABLE public.payroll_return_runs
  ADD CONSTRAINT payroll_return_runs_submission_channel_check
  CHECK (submission_channel IS NULL OR submission_channel = ANY (ARRAY[
    'itax','ecitizen','ura','tra','sars','elstam','manual','api','other'
  ]));

-- Audit trail for filing events (immutable history per run)
CREATE TABLE IF NOT EXISTS public.payroll_return_filing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.payroll_return_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  event text NOT NULL CHECK (event = ANY (ARRAY[
    'generated','submitted','acknowledged','rejected','filed','superseded','receipt_uploaded'
  ])),
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.payroll_return_filing_events TO authenticated;
GRANT ALL ON public.payroll_return_filing_events TO service_role;

ALTER TABLE public.payroll_return_filing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY return_filing_events_read
ON public.payroll_return_filing_events
FOR SELECT TO authenticated
USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));

CREATE POLICY return_filing_events_write
ON public.payroll_return_filing_events
FOR INSERT TO authenticated
WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write'));

CREATE POLICY return_filing_events_service
ON public.payroll_return_filing_events
FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS return_filing_events_run_idx
  ON public.payroll_return_filing_events (run_id, occurred_at DESC);

-- =========================================================================
-- P2.3: Filing calendar view — joins installed pack → return templates →
-- next due date computed from period + due_month_offset + due_day → latest
-- matching run (if any).
-- =========================================================================
CREATE OR REPLACE VIEW public.payroll_filing_calendar AS
WITH installed AS (
  SELECT ilp.organization_id, ilp.business_id, ilp.pack_id
  FROM public.installed_localization_packs ilp
  WHERE ilp.status = 'installed'
),
candidate_templates AS (
  -- Templates from the org's installed pack
  SELECT t.code, t.display_name, t.period, t.due_day, t.due_month_offset,
         t.authority_name, t.output, i.organization_id, i.business_id, t.pack_id
  FROM public.localization_pack_return_templates t
  JOIN installed i ON i.pack_id = t.pack_id
  UNION ALL
  -- Generic (pack_id NULL) templates available to every org
  SELECT t.code, t.display_name, t.period, t.due_day, t.due_month_offset,
         t.authority_name, t.output, i.organization_id, i.business_id, NULL::uuid
  FROM public.localization_pack_return_templates t
  CROSS JOIN installed i
  WHERE t.pack_id IS NULL
),
periods AS (
  -- Compute the most-recently-closed period (start, end) per template
  SELECT
    ct.*,
    CASE ct.period
      WHEN 'monthly' THEN
        date_trunc('month', (now() - interval '1 month'))::date
      WHEN 'quarterly' THEN
        (date_trunc('quarter', (now() - interval '3 months')))::date
      WHEN 'annual' THEN
        (date_trunc('year', (now() - interval '1 year')))::date
      ELSE date_trunc('month', now())::date
    END AS period_start,
    CASE ct.period
      WHEN 'monthly' THEN
        (date_trunc('month', now()) - interval '1 day')::date
      WHEN 'quarterly' THEN
        (date_trunc('quarter', now()) - interval '1 day')::date
      WHEN 'annual' THEN
        (date_trunc('year', now()) - interval '1 day')::date
      ELSE (date_trunc('month', now()) + interval '1 month' - interval '1 day')::date
    END AS period_end
  FROM candidate_templates ct
)
SELECT
  p.organization_id,
  p.business_id,
  p.pack_id,
  p.code AS template_code,
  p.display_name,
  p.period,
  p.authority_name,
  p.output,
  p.period_start,
  p.period_end,
  -- Due date = period_end + due_month_offset months + (due_day - end-of-month adj)
  (p.period_end
    + (COALESCE(p.due_month_offset, 1) || ' months')::interval
    - interval '1 day'
    + ((COALESCE(p.due_day, 28) - 28) || ' days')::interval
  )::date AS due_date,
  r.id AS latest_run_id,
  r.status AS latest_run_status,
  r.filed_at,
  r.submitted_at,
  CASE
    WHEN r.id IS NULL THEN 'not_started'
    WHEN r.status IN ('filed','acknowledged') THEN 'filed'
    WHEN r.status = 'rejected' THEN 'rejected'
    WHEN r.status = 'submitted_awaiting_ack' THEN 'awaiting_ack'
    WHEN r.status = 'generated' THEN 'generated'
    ELSE 'draft'
  END AS state,
  CASE
    WHEN r.status IN ('filed','acknowledged') THEN false
    WHEN (p.period_end
            + (COALESCE(p.due_month_offset, 1) || ' months')::interval
            - interval '1 day'
            + ((COALESCE(p.due_day, 28) - 28) || ' days')::interval
         )::date < CURRENT_DATE THEN true
    ELSE false
  END AS is_overdue
FROM periods p
LEFT JOIN LATERAL (
  SELECT id, status, filed_at, submitted_at
  FROM public.payroll_return_runs rr
  WHERE rr.organization_id = p.organization_id
    AND rr.business_id = p.business_id
    AND rr.template_code = p.code
    AND rr.period_start = p.period_start
    AND rr.period_end = p.period_end
    AND rr.status <> 'superseded'
  ORDER BY rr.created_at DESC
  LIMIT 1
) r ON true;

GRANT SELECT ON public.payroll_filing_calendar TO authenticated, service_role;
