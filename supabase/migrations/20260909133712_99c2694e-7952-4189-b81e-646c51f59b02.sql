CREATE OR REPLACE FUNCTION public.mf_postpone_group_meeting(
  p_meeting_id uuid,
  p_new_date date DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  m record;
BEGIN
  SELECT * INTO m FROM public.mf_group_meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This meeting does not exist';
  END IF;

  IF NOT public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'write', m.loan_officer_id) THEN
    RAISE EXCEPTION 'You are not allowed to change this meeting';
  END IF;

  IF m.status = 'completed' THEN
    RAISE EXCEPTION 'This meeting has already been completed and cannot be postponed';
  END IF;

  IF p_new_date IS NOT NULL AND p_new_date <= m.scheduled_on THEN
    RAISE EXCEPTION 'The new meeting date must be after the original meeting date';
  END IF;

  UPDATE public.mf_group_meetings
     SET status = CASE WHEN p_new_date IS NULL THEN 'missed' ELSE 'postponed' END,
         postponed_to = p_new_date,
         next_scheduled_on = COALESCE(p_new_date, public.mf_next_meeting_date(m.group_id, m.scheduled_on)),
         notes = COALESCE(p_reason, notes),
         closed_at = now(),
         closed_by = auth.uid()
   WHERE id = p_meeting_id;

  RETURN jsonb_build_object(
    'meeting_id', p_meeting_id,
    'status', CASE WHEN p_new_date IS NULL THEN 'missed' ELSE 'postponed' END,
    'next_scheduled_on', COALESCE(p_new_date, public.mf_next_meeting_date(m.group_id, m.scheduled_on))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mf_postpone_group_meeting(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_postpone_group_meeting(uuid, date, text) TO authenticated;