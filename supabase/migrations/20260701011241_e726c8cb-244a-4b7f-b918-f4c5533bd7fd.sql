
-- =============================================================================
-- G4 · Filing calendar projection (single-writer materialisation)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payroll_filing_calendar_projection (
  business_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  pack_id uuid NULL,
  template_code text NOT NULL,
  period_key text NOT NULL, -- e.g. '2026-05', '2026Q2', '2026'
  display_name text NOT NULL,
  period text NOT NULL,
  authority_name text NULL,
  output text NULL,
  approval_required boolean NOT NULL DEFAULT false,
  is_overridden boolean NOT NULL DEFAULT false,
  override_stale boolean NOT NULL DEFAULT false,
  upgrade_pending boolean NOT NULL DEFAULT false,
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_date date NOT NULL,
  latest_run_id uuid NULL,
  latest_run_status text NULL,
  reconciliation_status text NULL,
  approver_id uuid NULL,
  approved_at timestamptz NULL,
  filed_at timestamptz NULL,
  submitted_at timestamptz NULL,
  state text NOT NULL DEFAULT 'not_started',
  is_overdue boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, template_code, period_key)
);

CREATE INDEX IF NOT EXISTS idx_filing_calendar_projection_business
  ON public.payroll_filing_calendar_projection (business_id);
CREATE INDEX IF NOT EXISTS idx_filing_calendar_projection_org
  ON public.payroll_filing_calendar_projection (organization_id);
CREATE INDEX IF NOT EXISTS idx_filing_calendar_projection_due
  ON public.payroll_filing_calendar_projection (business_id, due_date);

GRANT SELECT ON public.payroll_filing_calendar_projection TO authenticated;
GRANT ALL    ON public.payroll_filing_calendar_projection TO service_role;

ALTER TABLE public.payroll_filing_calendar_projection ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS filing_calendar_projection_read ON public.payroll_filing_calendar_projection;
CREATE POLICY filing_calendar_projection_read
  ON public.payroll_filing_calendar_projection
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

-- No INSERT/UPDATE/DELETE policies: only service_role (bypasses RLS) writes.

-- ---------------------------------------------------------------------------
-- Single writer: refresh_filing_calendar_business
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_filing_calendar_business(_business_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _upserts integer := 0;
BEGIN
  -- Wipe rows that no longer exist in the recomputed slice for this business.
  DELETE FROM public.payroll_filing_calendar_projection p
   WHERE p.business_id = _business_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.installed_localization_packs ilp
         JOIN public.localization_pack_return_templates t
           ON (t.pack_id = ilp.pack_id OR t.pack_id IS NULL)
        WHERE ilp.business_id = _business_id
          AND ilp.status = 'installed'
          AND t.code = p.template_code
     );

  WITH installed AS (
    SELECT ilp.organization_id, ilp.business_id, ilp.pack_id
      FROM public.installed_localization_packs ilp
     WHERE ilp.business_id = _business_id
       AND ilp.status = 'installed'
  ),
  pending_upgrades AS (
    SELECT DISTINCT organization_id, business_id, pack_id
      FROM public.pack_upgrade_proposals
     WHERE business_id = _business_id
       AND status = 'pending'
  ),
  candidate_templates AS (
    SELECT t.code, t.display_name, t.period, t.due_day, t.due_month_offset,
           t.authority_name, t.output, t.approval_required,
           i.organization_id, i.business_id, t.pack_id,
           t.updated_at AS template_updated_at
      FROM public.localization_pack_return_templates t
      JOIN installed i ON i.pack_id = t.pack_id
    UNION ALL
    SELECT t.code, t.display_name, t.period, t.due_day, t.due_month_offset,
           t.authority_name, t.output, t.approval_required,
           i.organization_id, i.business_id, NULL::uuid,
           t.updated_at
      FROM public.localization_pack_return_templates t
      CROSS JOIN installed i
     WHERE t.pack_id IS NULL
  ),
  merged AS (
    SELECT ct.organization_id, ct.business_id, ct.pack_id,
           ct.code, ct.display_name, ct.period,
           COALESCE(o.due_day, ct.due_day) AS due_day,
           COALESCE(o.due_month_offset, ct.due_month_offset) AS due_month_offset,
           ct.authority_name,
           COALESCE(o.output, ct.output) AS output,
           ct.approval_required,
           (o.id IS NOT NULL) AS is_overridden,
           (o.base_template_updated_at IS NOT NULL
              AND o.base_template_updated_at <> ct.template_updated_at) AS override_stale,
           (pu.pack_id IS NOT NULL) AS upgrade_pending
      FROM candidate_templates ct
      LEFT JOIN public.payroll_return_template_overrides o
        ON o.business_id = ct.business_id AND o.template_code = ct.code
      LEFT JOIN pending_upgrades pu
        ON pu.organization_id = ct.organization_id
       AND pu.business_id = ct.business_id
       AND pu.pack_id = ct.pack_id
  ),
  periods AS (
    SELECT m.*,
           CASE m.period
             WHEN 'monthly'   THEN (date_trunc('month', now() - interval '1 mon'))::date
             WHEN 'quarterly' THEN (date_trunc('quarter', now() - interval '3 mons'))::date
             WHEN 'annual'    THEN (date_trunc('year', now() - interval '1 year'))::date
             ELSE (date_trunc('month', now()))::date
           END AS period_start,
           CASE m.period
             WHEN 'monthly'   THEN (date_trunc('month', now()) - interval '1 day')::date
             WHEN 'quarterly' THEN (date_trunc('quarter', now()) - interval '1 day')::date
             WHEN 'annual'    THEN (date_trunc('year', now()) - interval '1 day')::date
             ELSE (date_trunc('month', now()) + interval '1 mon' - interval '1 day')::date
           END AS period_end
      FROM merged m
  ),
  computed AS (
    SELECT p.organization_id, p.business_id, p.pack_id,
           p.code AS template_code, p.display_name, p.period,
           p.authority_name, p.output, p.approval_required,
           p.is_overridden, p.override_stale, p.upgrade_pending,
           p.period_start, p.period_end,
           CASE p.period
             WHEN 'monthly'   THEN to_char(p.period_start, 'YYYY-MM')
             WHEN 'quarterly' THEN to_char(p.period_start, 'YYYY"Q"Q')
             WHEN 'annual'    THEN to_char(p.period_start, 'YYYY')
             ELSE to_char(p.period_start, 'YYYY-MM')
           END AS period_key,
           (p.period_end
             + ((COALESCE(p.due_month_offset, 1) || ' months')::interval)
             - interval '1 day'
             + (((COALESCE(p.due_day, 28) - 28) || ' days')::interval)
           )::date AS due_date,
           r.id AS latest_run_id,
           r.status AS latest_run_status,
           r.reconciliation_status,
           r.approver_id,
           r.approved_at,
           r.filed_at, r.submitted_at,
           CASE
             WHEN r.id IS NULL THEN 'not_started'
             WHEN r.status IN ('filed','acknowledged') THEN 'filed'
             WHEN r.status = 'rejected' THEN 'rejected'
             WHEN r.status = 'submitted_awaiting_ack' THEN 'awaiting_ack'
             WHEN r.status = 'pending_approval' THEN 'pending_approval'
             WHEN r.status = 'generated' THEN 'generated'
             ELSE 'draft'
           END AS state,
           CASE
             WHEN r.status IN ('filed','acknowledged') THEN false
             WHEN (p.period_end + ((COALESCE(p.due_month_offset, 1) || ' months')::interval)
                   - interval '1 day'
                   + (((COALESCE(p.due_day, 28) - 28) || ' days')::interval))::date < CURRENT_DATE THEN true
             ELSE false
           END AS is_overdue
      FROM periods p
      LEFT JOIN LATERAL (
        SELECT rr.id, rr.status, rr.filed_at, rr.submitted_at,
               rr.reconciliation_status, rr.approver_id, rr.approved_at
          FROM public.payroll_return_runs rr
         WHERE rr.organization_id = p.organization_id
           AND rr.business_id = p.business_id
           AND rr.template_code = p.code
           AND rr.period_start = p.period_start
           AND rr.period_end = p.period_end
           AND rr.status <> 'superseded'
         ORDER BY rr.created_at DESC
         LIMIT 1
      ) r ON true
  )
  INSERT INTO public.payroll_filing_calendar_projection (
    business_id, organization_id, pack_id, template_code, period_key,
    display_name, period, authority_name, output, approval_required,
    is_overridden, override_stale, upgrade_pending,
    period_start, period_end, due_date,
    latest_run_id, latest_run_status, reconciliation_status,
    approver_id, approved_at, filed_at, submitted_at,
    state, is_overdue, updated_at
  )
  SELECT
    c.business_id, c.organization_id, c.pack_id, c.template_code, c.period_key,
    c.display_name, c.period, c.authority_name, c.output, c.approval_required,
    c.is_overridden, c.override_stale, c.upgrade_pending,
    c.period_start, c.period_end, c.due_date,
    c.latest_run_id, c.latest_run_status, c.reconciliation_status,
    c.approver_id, c.approved_at, c.filed_at, c.submitted_at,
    c.state, c.is_overdue, now()
  FROM computed c
  ON CONFLICT (business_id, template_code, period_key) DO UPDATE
     SET organization_id      = EXCLUDED.organization_id,
         pack_id              = EXCLUDED.pack_id,
         display_name         = EXCLUDED.display_name,
         period               = EXCLUDED.period,
         authority_name       = EXCLUDED.authority_name,
         output               = EXCLUDED.output,
         approval_required    = EXCLUDED.approval_required,
         is_overridden        = EXCLUDED.is_overridden,
         override_stale       = EXCLUDED.override_stale,
         upgrade_pending      = EXCLUDED.upgrade_pending,
         period_start         = EXCLUDED.period_start,
         period_end           = EXCLUDED.period_end,
         due_date             = EXCLUDED.due_date,
         latest_run_id        = EXCLUDED.latest_run_id,
         latest_run_status    = EXCLUDED.latest_run_status,
         reconciliation_status= EXCLUDED.reconciliation_status,
         approver_id          = EXCLUDED.approver_id,
         approved_at          = EXCLUDED.approved_at,
         filed_at             = EXCLUDED.filed_at,
         submitted_at         = EXCLUDED.submitted_at,
         state                = EXCLUDED.state,
         is_overdue           = EXCLUDED.is_overdue,
         updated_at           = now();

  GET DIAGNOSTICS _upserts = ROW_COUNT;
  RETURN _upserts;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_filing_calendar_business(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_filing_calendar_business(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Recreate view as a passthrough so every existing consumer keeps working.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.payroll_filing_calendar CASCADE;

CREATE VIEW public.payroll_filing_calendar
WITH (security_invoker = true)
AS
SELECT
  organization_id, business_id, pack_id,
  template_code, display_name, period,
  authority_name, output, approval_required,
  is_overridden, override_stale, upgrade_pending,
  period_start, period_end, due_date,
  latest_run_id, latest_run_status, reconciliation_status,
  approver_id, approved_at, filed_at, submitted_at,
  state, is_overdue
FROM public.payroll_filing_calendar_projection;

GRANT SELECT ON public.payroll_filing_calendar TO authenticated;

-- ---------------------------------------------------------------------------
-- Seed the projection for every currently-installed business so the calendar
-- is populated immediately, without waiting for the first outbox event.
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  b uuid;
BEGIN
  FOR b IN
    SELECT DISTINCT business_id
      FROM public.installed_localization_packs
     WHERE status = 'installed' AND business_id IS NOT NULL
  LOOP
    PERFORM public.refresh_filing_calendar_business(b);
  END LOOP;
END;
$seed$;
