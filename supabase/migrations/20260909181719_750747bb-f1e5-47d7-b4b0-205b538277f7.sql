CREATE OR REPLACE FUNCTION public.open_branch_day(
  p_branch_id uuid,
  p_business_date date DEFAULT NULL,
  p_opening_cash numeric DEFAULT 0,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b            record;
  v_date       date := COALESCE(p_business_date, CURRENT_DATE);
  v_open       record;
  v_last_closed date;
  v_day_id     uuid;
BEGIN
  SELECT br.id, br.name, br.business_id, br.organization_id, br.day_control_from, br.is_active
    INTO b
  FROM public.branches br WHERE br.id = p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch % not found', p_branch_id; END IF;

  IF NOT public.mf_can_scoped(b.business_id, b.id, 'treasury', 'write') THEN
    RAISE EXCEPTION 'You do not have permission to open the day at %', b.name;
  END IF;

  IF b.day_control_from IS NULL THEN
    RAISE EXCEPTION 'Day control is not enabled for %', b.name;
  END IF;
  IF v_date < b.day_control_from THEN
    RAISE EXCEPTION 'Day control at % starts on %', b.name, b.day_control_from;
  END IF;
  IF v_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'A branch day cannot be opened for a future date';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('branch_day:' || b.id::text));

  SELECT d.business_date INTO v_open
  FROM public.branch_operational_days d
  WHERE d.branch_id = b.id AND d.status = 'open'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Close % first — it is still open at %', v_open.business_date, b.name;
  END IF;

  IF EXISTS (SELECT 1 FROM public.branch_operational_days d
             WHERE d.branch_id = b.id AND d.business_date = v_date) THEN
    RAISE EXCEPTION '% has already been closed at %', v_date, b.name;
  END IF;

  SELECT max(d.business_date) INTO v_last_closed
  FROM public.branch_operational_days d
  WHERE d.branch_id = b.id AND d.status = 'closed';

  IF v_last_closed IS NOT NULL AND v_date < v_last_closed THEN
    RAISE EXCEPTION 'Cannot open % — % is already closed at %', v_date, v_last_closed, b.name;
  END IF;

  INSERT INTO public.branch_operational_days (
    organization_id, business_id, branch_id, business_date, status,
    opening_cash, notes, opened_by
  ) VALUES (
    b.organization_id, b.business_id, b.id, v_date, 'open',
    ROUND(COALESCE(p_opening_cash, 0), 2), p_notes, auth.uid()
  ) RETURNING id INTO v_day_id;

  INSERT INTO public.branch_day_events (
    organization_id, business_id, branch_id, operational_day_id, business_date,
    event_type, actor_id, opening_cash, reason
  ) VALUES (
    b.organization_id, b.business_id, b.id, v_day_id, v_date,
    'opened', auth.uid(), ROUND(COALESCE(p_opening_cash, 0), 2), p_notes
  );

  RETURN v_day_id;
END;
$$;

REVOKE ALL ON FUNCTION public.open_branch_day(uuid, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_branch_day(uuid, date, numeric, text) TO authenticated;