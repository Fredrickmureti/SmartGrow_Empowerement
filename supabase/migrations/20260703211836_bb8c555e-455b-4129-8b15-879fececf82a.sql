
-- =====================================================================
-- Phase 2 — Payroll Period state machine, atomic close/reopen, readiness,
-- sentinel-guarded status mutation, business_event_outbox emission.
-- Mirrors payroll_return_transition (ADR-0045 return-run pattern).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Governance helper columns on payroll_periods
-- ---------------------------------------------------------------------
ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS previous_status public.payroll_period_status,
  ADD COLUMN IF NOT EXISTS state_transitioned_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------
-- 1. Sentinel-guarded status trigger — only sanctioned RPCs may flip status
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_periods_status_sentinel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _sentinel text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    _sentinel := COALESCE(current_setting('app.period_rpc', true), '');
    IF _sentinel <> 'payroll_period_transition' THEN
      RAISE EXCEPTION
        'payroll_periods.status may only be mutated by payroll_period_transition() (attempted % -> %)',
        OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payroll_periods_status_sentinel ON public.payroll_periods;
CREATE TRIGGER trg_payroll_periods_status_sentinel
BEFORE UPDATE OF status ON public.payroll_periods
FOR EACH ROW EXECUTE FUNCTION public.payroll_periods_status_sentinel();

-- ---------------------------------------------------------------------
-- 2. payroll_period_transition() — the ONLY sanctioned status mutation
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_transition(
  _period_id uuid,
  _to_status public.payroll_period_status,
  _reason text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb
)
RETURNS public.payroll_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _period public.payroll_periods;
  _actor uuid := auth.uid();
  _allowed boolean := false;
  _from public.payroll_period_status;
BEGIN
  SELECT * INTO _period FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NOT NULL
     AND NOT public.user_has_module_permission(_actor, _period.organization_id, _period.business_id, 'payroll', 'manage') THEN
    RAISE EXCEPTION 'not authorized to transition payroll period in org %', _period.organization_id
      USING ERRCODE = '42501';
  END IF;

  _from := _period.status;

  _allowed := CASE _from
    WHEN 'open'              THEN _to_status IN ('preparing','cancelled')
    WHEN 'preparing'         THEN _to_status IN ('processing','open','cancelled')
    WHEN 'processing'        THEN _to_status IN ('awaiting_approval','preparing')
    WHEN 'awaiting_approval' THEN _to_status IN ('posted','processing')
    WHEN 'posted'            THEN _to_status IN ('paid','reopened')
    WHEN 'paid'              THEN _to_status IN ('closed','reopened')
    WHEN 'closed'            THEN _to_status IN ('reopened','archived')
    WHEN 'reopened'          THEN _to_status IN ('preparing','closed')
    WHEN 'cancelled'         THEN _to_status IN ('archived')
    WHEN 'archived'          THEN false
    ELSE false
  END;

  IF NOT _allowed THEN
    RAISE EXCEPTION 'illegal payroll period transition % -> %', _from, _to_status
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.period_rpc', 'payroll_period_transition', true);

  UPDATE public.payroll_periods
     SET previous_status = status,
         status = _to_status,
         state_transitioned_at = now(),
         updated_at = now(),
         closed_by     = CASE WHEN _to_status = 'closed'   THEN COALESCE(_actor, closed_by)   ELSE closed_by   END,
         closed_at     = CASE WHEN _to_status = 'closed'   THEN now()                          ELSE closed_at   END,
         close_reason  = CASE WHEN _to_status = 'closed'   THEN _reason                        ELSE close_reason END,
         reopened_by   = CASE WHEN _to_status = 'reopened' THEN COALESCE(_actor, reopened_by) ELSE reopened_by END,
         reopened_at   = CASE WHEN _to_status = 'reopened' THEN now()                          ELSE reopened_at END,
         reopen_reason = CASE WHEN _to_status = 'reopened' THEN _reason                        ELSE reopen_reason END
   WHERE id = _period_id
   RETURNING * INTO _period;

  PERFORM set_config('app.period_rpc', '', true);

  INSERT INTO public.payroll_period_audit
    (period_id, organization_id, business_id, from_status, to_status, actor_id, actor_role, reason, payload)
  VALUES
    (_period.id, _period.organization_id, _period.business_id,
     _from, _to_status, _actor, NULL, _reason, COALESCE(_payload,'{}'::jsonb));

  RETURN _period;
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_transition(uuid, public.payroll_period_status, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_transition(uuid, public.payroll_period_status, text, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. payroll_period_readiness() — structured blocker jsonb
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_readiness(_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _pending_timesheets int;
  _pending_leave int;
  _pending_attendance int;
  _draft_runs int;
  _unposted_journals int;
  _unpaid_remittances int;
  _open_return_runs int;
  _blockers jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO _pending_timesheets
    FROM public.timesheets t
   WHERE t.business_id = _p.business_id
     AND t.date BETWEEN _p.start_date AND _p.end_date
     AND t.status NOT IN ('approved','rejected','cancelled');

  SELECT count(*) INTO _pending_leave
    FROM public.leave_requests l
   WHERE l.business_id = _p.business_id
     AND l.status = 'pending'
     AND daterange(l.start_date, l.end_date, '[]') && daterange(_p.start_date, _p.end_date, '[]');

  SELECT count(*) INTO _pending_attendance
    FROM public.attendance_corrections a
   WHERE a.business_id = _p.business_id
     AND a.attendance_date BETWEEN _p.start_date AND _p.end_date
     AND a.status = 'pending';

  SELECT count(*) INTO _draft_runs
    FROM public.payroll_runs r
   WHERE r.business_id = _p.business_id
     AND (r.period_id = _p.id
          OR (r.pay_period_start >= _p.start_date AND r.pay_period_end <= _p.end_date))
     AND r.status IN ('draft','calculating','failed');

  SELECT count(*) INTO _unposted_journals
    FROM public.journal_entries j
   WHERE j.business_id = _p.business_id
     AND j.entry_date BETWEEN _p.start_date AND _p.end_date
     AND j.status IN ('draft','pending');

  SELECT count(*) INTO _unpaid_remittances
    FROM public.payroll_remittances rm
   WHERE rm.business_id = _p.business_id
     AND rm.due_date BETWEEN _p.start_date AND _p.end_date
     AND rm.status NOT IN ('paid','completed','cancelled');

  SELECT count(*) INTO _open_return_runs
    FROM public.payroll_return_runs rr
   WHERE rr.business_id = _p.business_id
     AND daterange(rr.period_start, rr.period_end, '[]') && daterange(_p.start_date, _p.end_date, '[]')
     AND rr.status NOT IN ('filed','superseded','rejected');

  IF _pending_timesheets > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','pending_timesheets','count',_pending_timesheets,'severity','error');
  END IF;
  IF _pending_leave > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','pending_leave','count',_pending_leave,'severity','warning');
  END IF;
  IF _pending_attendance > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','pending_attendance_corrections','count',_pending_attendance,'severity','error');
  END IF;
  IF _draft_runs > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','draft_or_failed_runs','count',_draft_runs,'severity','error');
  END IF;
  IF _unposted_journals > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','unposted_journals','count',_unposted_journals,'severity','error');
  END IF;
  IF _unpaid_remittances > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','unpaid_remittances','count',_unpaid_remittances,'severity','warning');
  END IF;
  IF _open_return_runs > 0 THEN
    _blockers := _blockers || jsonb_build_object('code','open_return_runs','count',_open_return_runs,'severity','warning');
  END IF;

  RETURN jsonb_build_object(
    'period_id', _p.id,
    'status', _p.status,
    'checked_at', now(),
    'blockers', _blockers,
    'ready', (jsonb_array_length(_blockers) = 0),
    'counts', jsonb_build_object(
      'pending_timesheets', _pending_timesheets,
      'pending_leave', _pending_leave,
      'pending_attendance_corrections', _pending_attendance,
      'draft_or_failed_runs', _draft_runs,
      'unposted_journals', _unposted_journals,
      'unpaid_remittances', _unpaid_remittances,
      'open_return_runs', _open_return_runs
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_readiness(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_readiness(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. payroll_period_close_atomic() — readiness + lock cascade + transition
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_close_atomic(
  _period_id uuid,
  _reason text DEFAULT NULL,
  _force boolean DEFAULT false,
  _override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _readiness jsonb;
  _locked int := 0;
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

  _readiness := public.payroll_period_readiness(_period_id);

  IF (_readiness->>'ready')::boolean IS DISTINCT FROM true AND NOT _force THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'blocked',
      'readiness', _readiness
    );
  END IF;

  IF _force AND (_override_reason IS NULL OR length(trim(_override_reason)) = 0) THEN
    RAISE EXCEPTION 'override_reason required when forcing close over blockers' USING ERRCODE = '22023';
  END IF;

  -- Lock cascade (Phase 2: timesheets only; Phase 3 extends to more tables)
  UPDATE public.timesheets
     SET payroll_locked = true,
         payroll_locked_at = COALESCE(payroll_locked_at, now()),
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND status = 'approved'
     AND payroll_locked IS DISTINCT FROM true;
  GET DIAGNOSTICS _locked = ROW_COUNT;

  _payload := jsonb_build_object(
    'readiness', _readiness,
    'timesheets_locked', _locked,
    'force', _force,
    'override_reason', _override_reason
  );

  PERFORM public.payroll_period_transition(
    _period_id,
    'closed'::public.payroll_period_status,
    COALESCE(_reason, _override_reason),
    _payload
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'closed',
    'timesheets_locked', _locked,
    'readiness', _readiness
  );
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_close_atomic(uuid, text, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_close_atomic(uuid, text, boolean, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. payroll_period_reopen_atomic() — maker-checker reopen with reason
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_reopen_atomic(
  _period_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _unlocked int := 0;
  _actor uuid := auth.uid();
BEGIN
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'reason is required to reopen a closed payroll period' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NULL
     OR NOT (public.has_role(_actor, _p.organization_id, 'admin'::public.app_role)
             OR public.has_role(_actor, _p.organization_id, 'hr_admin'::public.app_role)
             OR public.has_role(_actor, _p.organization_id, 'payroll_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'not authorized to reopen payroll period' USING ERRCODE = '42501';
  END IF;

  -- Unlock cascade (Phase 2: timesheets only)
  UPDATE public.timesheets
     SET payroll_locked = false,
         payroll_locked_at = NULL,
         updated_at = now()
   WHERE business_id = _p.business_id
     AND date BETWEEN _p.start_date AND _p.end_date
     AND payroll_locked = true;
  GET DIAGNOSTICS _unlocked = ROW_COUNT;

  PERFORM public.payroll_period_transition(
    _period_id,
    'reopened'::public.payroll_period_status,
    _reason,
    jsonb_build_object('timesheets_unlocked', _unlocked)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'reopened',
    'timesheets_unlocked', _unlocked
  );
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_reopen_atomic(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_reopen_atomic(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Outbox emission on every audit insert (same-txn, idempotent)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_emit_payroll_period_state_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
BEGIN
  _event := 'payroll.period.' || NEW.to_status::text;
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, actor_user_id, idempotency_key)
  VALUES
    (NEW.organization_id,
     _event,
     'payroll_period',
     NEW.period_id,
     jsonb_build_object(
       'period_id', NEW.period_id,
       'business_id', NEW.business_id,
       'from_status', NEW.from_status,
       'to_status', NEW.to_status,
       'reason', NEW.reason,
       'payload', NEW.payload
     ),
     NEW.actor_id,
     'payroll.period.state_changed:' || NEW.id::text)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS emit_payroll_period_state_changed ON public.payroll_period_audit;
CREATE TRIGGER emit_payroll_period_state_changed
AFTER INSERT ON public.payroll_period_audit
FOR EACH ROW EXECUTE FUNCTION public.trg_emit_payroll_period_state_changed();
