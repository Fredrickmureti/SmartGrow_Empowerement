CREATE OR REPLACE FUNCTION public.reopen_branch_day(
  p_day_id uuid,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d      record;
  v_open date;
BEGIN
  IF COALESCE(btrim(COALESCE(p_reason, '')), '') = '' THEN
    RAISE EXCEPTION 'Reopening a closed day needs a reason';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('branch_day:' || p_day_id::text));

  SELECT * INTO d FROM public.branch_operational_days WHERE id = p_day_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch day % not found', p_day_id; END IF;
  IF d.status <> 'closed' THEN RAISE EXCEPTION 'This day is not closed'; END IF;

  IF NOT public.mf_can_scoped(d.business_id, d.branch_id, 'treasury', 'admin_override') THEN
    RAISE EXCEPTION 'You do not have permission to reopen a closed day';
  END IF;

  SELECT o.business_date INTO v_open
  FROM public.branch_operational_days o
  WHERE o.branch_id = d.branch_id AND o.status = 'open'
  LIMIT 1;
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'Close % first — a branch can only have one day open at a time', v_open;
  END IF;

  UPDATE public.branch_operational_days
     SET status = 'open',
         closed_by = NULL,
         closed_at = NULL,
         reopened_count = reopened_count + 1
   WHERE id = p_day_id;

  INSERT INTO public.branch_day_events (
    organization_id, business_id, branch_id, operational_day_id, business_date,
    event_type, actor_id, opening_cash, expected_cash, counted_cash, variance, reason
  ) VALUES (
    d.organization_id, d.business_id, d.branch_id, d.id, d.business_date,
    'reopened', auth.uid(), d.opening_cash, d.expected_cash, d.counted_cash, d.variance, p_reason
  );

  RETURN p_day_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_branch_day(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_branch_day(uuid, text) TO authenticated;