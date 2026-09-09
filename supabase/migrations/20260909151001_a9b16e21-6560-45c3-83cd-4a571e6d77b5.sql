DROP FUNCTION IF EXISTS public.mf_complete_group_meeting(uuid, text);

CREATE OR REPLACE FUNCTION public.mf_complete_group_meeting(
  p_meeting_id uuid,
  p_notes text DEFAULT NULL,
  p_started_at_time time DEFAULT NULL,
  p_ended_at_time time DEFAULT NULL,
  p_held_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  m record;
  v_next date;
  v_open_batches integer;
  v_start time;
  v_end time;
BEGIN
  SELECT * INTO m FROM public.mf_group_meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This meeting does not exist';
  END IF;

  IF NOT public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'write', m.loan_officer_id) THEN
    RAISE EXCEPTION 'You are not allowed to complete this meeting';
  END IF;

  IF m.status = 'completed' THEN
    RAISE EXCEPTION 'This meeting has already been completed';
  END IF;
  IF m.status IN ('postponed','missed') THEN
    RAISE EXCEPTION 'This meeting was recorded as % and can no longer be completed', m.status;
  END IF;
  IF m.opened_at IS NULL THEN
    RAISE EXCEPTION 'Open the meeting before completing it';
  END IF;

  v_start := COALESCE(p_started_at_time, m.started_at_time, m.scheduled_time);
  v_end := COALESCE(p_ended_at_time, m.ended_at_time);

  IF v_end IS NULL THEN
    RAISE EXCEPTION 'Record the time the meeting ended before completing it';
  END IF;
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'Record the time the meeting started before completing it';
  END IF;
  IF v_end <= v_start THEN
    RAISE EXCEPTION 'The meeting cannot end at or before the time it started';
  END IF;

  IF p_held_by IS NOT NULL
     AND public.user_branch_scope(auth.uid(), (SELECT b.organization_id FROM public.businesses b WHERE b.id = m.business_id)) = 'own_portfolio'
     AND p_held_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only record meetings you held yourself';
  END IF;

  SELECT count(*) INTO v_open_batches
    FROM public.mf_repayment_batches b
   WHERE b.meeting_id = p_meeting_id AND b.status <> 'closed';

  IF v_open_batches > 0 THEN
    IF NOT public.mf_can(m.business_id, m.branch_id, 'repayments', 'write') THEN
      RAISE EXCEPTION 'This meeting still has an open collection round; someone who can record repayments must close it first';
    END IF;
    UPDATE public.mf_repayment_batches
       SET status = 'closed'
     WHERE meeting_id = p_meeting_id AND status <> 'closed';
  END IF;

  v_next := public.mf_next_meeting_date(m.group_id, m.scheduled_on);

  UPDATE public.mf_group_meetings
     SET status = 'completed',
         closed_at = now(),
         closed_by = auth.uid(),
         recorded_by = auth.uid(),
         held_by = COALESCE(p_held_by, held_by, loan_officer_id),
         started_at_time = v_start,
         ended_at_time = v_end,
         notes = COALESCE(p_notes, notes),
         next_scheduled_on = v_next
   WHERE id = p_meeting_id;

  RETURN jsonb_build_object(
    'meeting_id', p_meeting_id,
    'status', 'completed',
    'started_at_time', v_start,
    'ended_at_time', v_end,
    'has_recurring_schedule', v_next IS NOT NULL,
    'next_scheduled_on', v_next
  );
END;
$function$;