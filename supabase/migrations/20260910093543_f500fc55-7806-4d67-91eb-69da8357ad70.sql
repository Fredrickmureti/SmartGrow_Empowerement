CREATE OR REPLACE FUNCTION public.set_branch_day_control(
  p_branch_id uuid,
  p_day_control_from date DEFAULT NULL,
  p_variance_tolerance numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.branches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b        record;
  v_from   date := p_day_control_from;
  v_tol    numeric;
  v_days   integer;
  v_open   integer;
  v_row    public.branches;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('branch_day_control:' || p_branch_id::text));

  SELECT * INTO b FROM public.branches WHERE id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch % not found', p_branch_id;
  END IF;

  IF NOT public.mf_can_scoped(b.business_id, b.id, 'settings', 'write') THEN
    RAISE EXCEPTION 'You do not have permission to change the day control settings at %', b.name;
  END IF;

  v_tol := ROUND(COALESCE(p_variance_tolerance, b.day_variance_tolerance, 0), 2);
  IF v_tol < 0 THEN
    RAISE EXCEPTION 'The allowed cash difference cannot be negative';
  END IF;

  SELECT count(*) INTO v_days
  FROM public.branch_operational_days d WHERE d.branch_id = b.id;

  SELECT count(*) INTO v_open
  FROM public.branch_operational_days d
  WHERE d.branch_id = b.id AND d.status = 'open';

  IF v_from IS DISTINCT FROM b.day_control_from THEN
    -- Switching off
    IF v_from IS NULL THEN
      IF v_open > 0 THEN
        RAISE EXCEPTION 'Close the day that is still open at % before switching day control off', b.name;
      END IF;
    ELSE
      IF v_from < CURRENT_DATE THEN
        RAISE EXCEPTION 'Day control can only start today or later — it cannot be back-dated to %', v_from;
      END IF;
      IF b.day_control_from IS NOT NULL AND v_days > 0 THEN
        RAISE EXCEPTION 'Day control has already been running at % — its start date can no longer be changed', b.name;
      END IF;
    END IF;

    IF COALESCE(btrim(p_reason), '') = '' AND b.day_control_from IS NOT NULL THEN
      RAISE EXCEPTION 'Say why day control is being changed at %', b.name;
    END IF;
  END IF;

  UPDATE public.branches
     SET day_control_from = v_from,
         day_variance_tolerance = v_tol,
         updated_at = now()
   WHERE id = b.id
  RETURNING * INTO v_row;

  IF v_from IS DISTINCT FROM b.day_control_from
     OR v_tol IS DISTINCT FROM b.day_variance_tolerance THEN
    INSERT INTO public.audit_logs (
      organization_id, business_id, user_id, action, entity_type, entity_id,
      entity_name, old_values, new_values, changes_summary
    ) VALUES (
      b.organization_id, b.business_id, auth.uid(),
      CASE
        WHEN b.day_control_from IS NULL AND v_from IS NOT NULL THEN 'branch_day_control_activated'
        WHEN v_from IS NULL AND b.day_control_from IS NOT NULL THEN 'branch_day_control_deactivated'
        ELSE 'branch_day_control_updated'
      END,
      'branch', b.id, b.name,
      jsonb_build_object('day_control_from', b.day_control_from,
                         'day_variance_tolerance', b.day_variance_tolerance),
      jsonb_build_object('day_control_from', v_from,
                         'day_variance_tolerance', v_tol),
      NULLIF(btrim(COALESCE(p_reason, '')), '')
    );
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_branch_day_control(uuid, date, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_branch_day_control(uuid, date, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_branch_day_control(uuid, date, numeric, text) TO authenticated;