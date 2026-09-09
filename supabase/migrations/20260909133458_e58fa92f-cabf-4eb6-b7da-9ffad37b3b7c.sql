CREATE OR REPLACE FUNCTION public.mf_next_meeting_date(p_group_id uuid, p_after date)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_day smallint;
  v_delta integer;
BEGIN
  SELECT meeting_day INTO v_day FROM public.mf_groups WHERE id = p_group_id;
  IF v_day IS NULL THEN
    RETURN NULL;
  END IF;
  -- meeting_day follows ISO weekday numbering (1 = Monday .. 7 = Sunday).
  v_delta := ((v_day - EXTRACT(ISODOW FROM p_after)::integer) + 7) % 7;
  IF v_delta = 0 THEN
    v_delta := 7;
  END IF;
  RETURN p_after + v_delta;
END;
$$;

REVOKE ALL ON FUNCTION public.mf_next_meeting_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_next_meeting_date(uuid, date) TO authenticated, service_role;