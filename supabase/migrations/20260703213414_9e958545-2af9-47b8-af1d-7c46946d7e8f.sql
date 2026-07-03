
CREATE OR REPLACE FUNCTION public.payroll_period_transition(
  _period_id uuid,
  _to_status public.payroll_period_status,
  _reason text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb
)
RETURNS public.payroll_periods
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
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
    WHEN 'open'              THEN _to_status IN ('preparing','cancelled','closed')
    WHEN 'preparing'         THEN _to_status IN ('processing','open','cancelled','closed')
    WHEN 'processing'        THEN _to_status IN ('awaiting_approval','preparing','closed')
    WHEN 'awaiting_approval' THEN _to_status IN ('posted','processing','closed')
    WHEN 'posted'            THEN _to_status IN ('paid','reopened','closed')
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
