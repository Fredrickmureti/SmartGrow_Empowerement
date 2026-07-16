-- Context-aware employee notification on profile change review.
-- Message now includes the human-readable old → new values so both the
-- in-app notification and the downstream send-notification-email trigger
-- deliver "your request to change {field} from X to Y was approved/rejected".

CREATE OR REPLACE FUNCTION public.review_profile_change_request(
  p_request_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_emp_user_id uuid;
  v_event_type public.employee_lifecycle_event_type;
  v_old_txt text;
  v_new_txt text;
  v_field_label text;
BEGIN
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'owner')
  ) THEN
    RAISE EXCEPTION 'Only HR admins may review change requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req FROM public.employee_profile_change_requests
   WHERE id = p_request_id AND status = 'pending' FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found or not pending';
  END IF;

  UPDATE public.employee_profile_change_requests SET
    status = p_decision,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = p_note,
    updated_at = now()
  WHERE id = p_request_id;

  IF p_decision = 'approved' THEN
    EXECUTE format(
      'UPDATE public.employees SET %I = $1, updated_at = now() WHERE id = $2',
      v_req.field_key
    ) USING (v_req.new_value #>> '{}'), v_req.employee_id;
    v_event_type := 'profile_change_approved';
  ELSE
    v_event_type := 'profile_change_rejected';
  END IF;

  INSERT INTO public.employee_lifecycle_events
    (organization_id, employee_id, event_type, actor_user_id,
     source_table, source_id, summary, payload)
  VALUES
    (v_req.organization_id, v_req.employee_id, v_event_type, auth.uid(),
     'employee_profile_change_requests', v_req.id,
     format('%s change to %s', initcap(p_decision), v_req.field_key),
     jsonb_build_object('field_key', v_req.field_key,
                        'old_value', v_req.old_value,
                        'new_value', v_req.new_value,
                        'decision', p_decision,
                        'note', p_note));

  -- Human-readable old/new for the notification body.
  v_old_txt := COALESCE(NULLIF(v_req.old_value #>> '{}', ''), '(empty)');
  v_new_txt := COALESCE(NULLIF(v_req.new_value #>> '{}', ''), '(empty)');
  v_field_label := replace(initcap(replace(v_req.field_key, '_', ' ')), '  ', ' ');

  SELECT user_id INTO v_emp_user_id FROM public.employees WHERE id = v_req.employee_id;
  IF v_emp_user_id IS NOT NULL THEN
    INSERT INTO public.notifications
      (user_id, organization_id, title, message, type, category, priority,
       entity_type, entity_id, link)
    VALUES
      (v_emp_user_id, v_req.organization_id,
       CASE WHEN p_decision = 'approved'
            THEN format('%s change approved', v_field_label)
            ELSE format('%s change rejected', v_field_label) END,
       format('Your request to change %s from "%s" to "%s" was %s%s.',
              v_field_label, v_old_txt, v_new_txt, p_decision,
              CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0
                   THEN ' — ' || p_note ELSE '' END),
       CASE WHEN p_decision = 'approved' THEN 'success' ELSE 'warning' END,
       'hr', 2,
       'employee_profile_change_request', v_req.id,
       '/me/profile');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_profile_change_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_profile_change_request(uuid, text, text) TO authenticated;