CREATE OR REPLACE FUNCTION public.mf_open_group_meeting(
  p_group_id uuid,
  p_meeting_on date DEFAULT CURRENT_DATE
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  g record;
  v_id uuid;
  v_status text;
BEGIN
  SELECT * INTO g FROM public.mf_groups WHERE id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This group does not exist';
  END IF;

  IF NOT public.mf_can_scoped(g.business_id, g.branch_id, 'clients', 'write', g.loan_officer_id) THEN
    RAISE EXCEPTION 'You are not allowed to run meetings for this group';
  END IF;

  IF g.status = 'closed' THEN
    RAISE EXCEPTION 'This group is closed; no further meetings can be held';
  END IF;

  SELECT id, status INTO v_id, v_status
    FROM public.mf_group_meetings
   WHERE group_id = p_group_id AND scheduled_on = p_meeting_on;

  IF v_id IS NOT NULL THEN
    IF v_status = 'completed' THEN
      RAISE EXCEPTION 'This meeting has already been completed';
    END IF;
    UPDATE public.mf_group_meetings
       SET status = 'in_progress',
           opened_at = COALESCE(opened_at, now()),
           opened_by = COALESCE(opened_by, auth.uid()),
           loan_officer_id = COALESCE(loan_officer_id, g.loan_officer_id)
     WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.mf_group_meetings (
    business_id, branch_id, group_id, loan_officer_id,
    scheduled_on, scheduled_time, meeting_place,
    status, opened_at, opened_by, created_by
  ) VALUES (
    g.business_id, g.branch_id, g.id, g.loan_officer_id,
    p_meeting_on, g.meeting_time, g.meeting_place,
    'in_progress', now(), auth.uid(), auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mf_open_group_meeting(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_open_group_meeting(uuid, date) TO authenticated;