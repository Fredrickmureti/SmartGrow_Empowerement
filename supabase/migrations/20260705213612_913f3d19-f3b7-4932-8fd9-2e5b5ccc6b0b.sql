CREATE TABLE IF NOT EXISTS public.payroll_period_close_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  workflow text NOT NULL CHECK (workflow IN ('posting','payment','bank_file','returns')),
  scope text NOT NULL DEFAULT 'period' CHECK (scope IN ('period','run')),
  run_id uuid NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(trim(reason)) >= 8),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.payroll_period_close_waivers TO authenticated;
GRANT ALL ON public.payroll_period_close_waivers TO service_role;

ALTER TABLE public.payroll_period_close_waivers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll managers read waivers" ON public.payroll_period_close_waivers;
CREATE POLICY "payroll managers read waivers"
  ON public.payroll_period_close_waivers
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));

DROP POLICY IF EXISTS "payroll managers insert waivers" ON public.payroll_period_close_waivers;
CREATE POLICY "payroll managers insert waivers"
  ON public.payroll_period_close_waivers
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
  );

CREATE INDEX IF NOT EXISTS idx_payroll_period_close_waivers_period
  ON public.payroll_period_close_waivers (period_id, workflow);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_close_waivers_period_scope
  ON public.payroll_period_close_waivers (period_id, workflow)
  WHERE scope = 'period';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_close_waivers_run_scope
  ON public.payroll_period_close_waivers (period_id, workflow, run_id)
  WHERE scope = 'run';

CREATE OR REPLACE FUNCTION public.payroll_period_workflow_blockers(_period_id uuid)
RETURNS TABLE (
  run_id uuid,
  workflow text,
  current_state text,
  required_states text[],
  waived boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH period AS (
    SELECT id, organization_id, business_id, start_date, end_date
    FROM public.payroll_periods
    WHERE id = _period_id
  ),
  runs AS (
    SELECT r.id, r.posting_status, r.payment_status, r.bank_file_status
    FROM public.payroll_runs r
    WHERE r.period_id = _period_id
      AND COALESCE(r.is_reversal, false) = false
  ),
  returns_bad AS (
    -- Statutory return runs whose date range overlaps this period and
    -- are NOT in a terminal accepted/submitted state. Matches on the
    -- payroll_return_runs schema which keys on period_start/period_end,
    -- not on a per-run FK.
    SELECT rr.id
    FROM public.payroll_return_runs rr
    JOIN period p
      ON rr.organization_id = p.organization_id
     AND rr.business_id     = p.business_id
     AND rr.period_start   <= p.end_date
     AND rr.period_end     >= p.start_date
    WHERE rr.status NOT IN ('submitted','accepted','filed','acknowledged','waived')
  ),
  candidates AS (
    SELECT id AS run_id, 'posting'::text AS workflow,
           COALESCE(posting_status,'not_posted') AS current_state,
           ARRAY['posted','reversed']::text[] AS required
    FROM runs
    UNION ALL
    SELECT id, 'payment', COALESCE(payment_status,'pending'),
           ARRAY['fully_paid','on_hold']::text[]
    FROM runs
    UNION ALL
    SELECT id, 'bank_file', COALESCE(bank_file_status,'not_generated'),
           ARRAY['sent','acknowledged','not_generated_waived']::text[]
    FROM runs
    UNION ALL
    -- Returns are period-scoped, not run-scoped, so emit a single row
    -- keyed by run_id = NULL when any return is outstanding.
    SELECT NULL::uuid, 'returns', 'outstanding',
           ARRAY['all_submitted']::text[]
    WHERE EXISTS (SELECT 1 FROM returns_bad)
  )
  SELECT c.run_id, c.workflow, c.current_state, c.required,
         EXISTS (
           SELECT 1 FROM public.payroll_period_close_waivers w
           WHERE w.period_id = _period_id
             AND w.workflow = c.workflow
             AND (w.scope = 'period' OR w.run_id = c.run_id)
         ) AS waived
  FROM candidates c
  WHERE NOT (c.current_state = ANY (c.required));
$$;

REVOKE ALL ON FUNCTION public.payroll_period_workflow_blockers(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_workflow_blockers(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payroll_period_close_atomic(
  _period_id uuid,
  _reason text DEFAULT NULL,
  _force boolean DEFAULT false,
  _override_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _readiness jsonb;
  _blockers jsonb;
  _unwaived int;
  _locked int := 0;
  _att_locked int := 0;
  _payload jsonb;
  _actor uuid := auth.uid();
BEGIN
  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NULL
     OR NOT public.user_has_module_permission(_actor, _p.organization_id, _p.business_id, 'payroll', 'manage') THEN
    RAISE EXCEPTION 'not authorized to close payroll period' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_agg(row_to_json(b)) FILTER (WHERE b.waived = false),
         count(*) FILTER (WHERE b.waived = false)
    INTO _blockers, _unwaived
  FROM public.payroll_period_workflow_blockers(_period_id) b;

  IF COALESCE(_unwaived, 0) > 0 AND NOT _force THEN
    INSERT INTO public.business_event_outbox (
      org_id, event_type, source_doc_type, source_doc_id, payload, actor_user_id
    ) VALUES (
      _p.organization_id, 'payroll_period.close_blocked', 'payroll_period', _period_id,
      jsonb_build_object('blockers', _blockers), _actor
    );
    RETURN jsonb_build_object(
      'ok', false, 'code', 'workflow_blocked',
      'blockers', COALESCE(_blockers, '[]'::jsonb)
    );
  END IF;

  _readiness := public.payroll_period_readiness(_period_id);

  IF (_readiness->>'ready')::boolean IS DISTINCT FROM true AND NOT _force THEN
    RETURN jsonb_build_object('ok', false, 'code', 'blocked', 'readiness', _readiness);
  END IF;

  IF _force AND (_override_reason IS NULL OR length(trim(_override_reason)) = 0) THEN
    RAISE EXCEPTION 'override_reason required when forcing close over blockers' USING ERRCODE = '22023';
  END IF;

  UPDATE public.timesheets
     SET payroll_locked = true,
         payroll_locked_at = COALESCE(payroll_locked_at, now()),
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND status = 'approved'
     AND payroll_locked IS DISTINCT FROM true;
  GET DIAGNOSTICS _locked = ROW_COUNT;

  _att_locked := public.attendance_lock_for_period(_p.organization_id, _p.start_date, _p.end_date);

  _payload := jsonb_build_object(
    'readiness', _readiness,
    'workflow_blockers', COALESCE(_blockers, '[]'::jsonb),
    'timesheets_locked', _locked,
    'attendance_locked', _att_locked,
    'force', _force,
    'override_reason', _override_reason
  );

  PERFORM public.payroll_period_transition(
    _period_id, 'closed'::public.payroll_period_status,
    COALESCE(_reason, _override_reason), _payload
  );

  INSERT INTO public.business_event_outbox (
    org_id, event_type, source_doc_type, source_doc_id, payload, actor_user_id
  ) VALUES (
    _p.organization_id, 'payroll_period.closed', 'payroll_period', _period_id,
    _payload, _actor
  );

  RETURN jsonb_build_object(
    'ok', true, 'code', 'closed',
    'timesheets_locked', _locked,
    'attendance_locked', _att_locked,
    'workflow_blockers', COALESCE(_blockers, '[]'::jsonb),
    'readiness', _readiness
  );
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_close_atomic(uuid, text, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_close_atomic(uuid, text, boolean, text) TO authenticated, service_role;

COMMENT ON COLUMN public.payroll_runs.status IS
  'Calculation lifecycle only (draft|calculating|calculated|approved|cancelled|reversed). '
  'The values ''posted'' and ''paid'' are DEPRECATED — read posting_status / payment_status instead. '
  'See ADR-0058 (payroll parallel workflows).';

CREATE OR REPLACE VIEW public.payroll_runs_legacy_status_v AS
SELECT
  r.id,
  r.status AS calculation_status,
  r.posting_status,
  r.payment_status,
  r.bank_file_status,
  r.payslip_issuance_status,
  CASE
    WHEN r.payment_status = 'fully_paid'                THEN 'paid'
    WHEN r.posting_status IN ('posted','reversed')      THEN 'posted'
    ELSE r.status
  END AS legacy_status
FROM public.payroll_runs r;

GRANT SELECT ON public.payroll_runs_legacy_status_v TO authenticated, service_role;

COMMENT ON VIEW public.payroll_runs_legacy_status_v IS
  'Read-only compatibility view for retiring payroll_runs.status coupling. '
  'New code MUST read the workflow-state columns directly. See ADR-0058.';