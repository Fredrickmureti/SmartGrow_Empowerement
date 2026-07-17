-- Root cause: the review RPC only inserted an in-app notification. Nothing
-- invoked send-notification-email, so approved/rejected profile-change
-- requests never triggered the branded email even though the domain, the
-- transport, and the user's preference were all correctly configured.
--
-- Fix: return the notification payload so the caller can invoke the email
-- edge function using the exact same title/message/context. Also include
-- notification_id (for delivery audit) and business_id (for tenant sender
-- identity resolution per ADR 0023).

DROP FUNCTION IF EXISTS public.review_profile_change_request(uuid, text, text);

CREATE OR REPLACE FUNCTION public.review_profile_change_request(
  p_request_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_emp record;
  v_event_type public.employee_lifecycle_event_type;
  v_old_txt text;
  v_new_txt text;
  v_field_label text;
  v_title text;
  v_message text;
  v_notif_id uuid;
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

  v_old_txt := COALESCE(NULLIF(v_req.old_value #>> '{}', ''), '(empty)');
  v_new_txt := COALESCE(NULLIF(v_req.new_value #>> '{}', ''), '(empty)');
  v_field_label := replace(initcap(replace(v_req.field_key, '_', ' ')), '  ', ' ');

  v_title := CASE WHEN p_decision = 'approved'
                  THEN format('%s change approved', v_field_label)
                  ELSE format('%s change rejected', v_field_label) END;
  v_message := format('Your request to change %s from "%s" to "%s" was %s%s.',
                      v_field_label, v_old_txt, v_new_txt, p_decision,
                      CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0
                           THEN ' — ' || p_note ELSE '' END);

  SELECT user_id, business_id INTO v_emp
    FROM public.employees WHERE id = v_req.employee_id;

  IF v_emp.user_id IS NOT NULL THEN
    INSERT INTO public.notifications
      (user_id, organization_id, business_id, title, message, type, category, priority,
       entity_type, entity_id, link)
    VALUES
      (v_emp.user_id, v_req.organization_id, v_emp.business_id,
       v_title, v_message,
       CASE WHEN p_decision = 'approved' THEN 'success' ELSE 'warning' END,
       'hr', 2,
       'employee_profile_change_request', v_req.id,
       '/me/profile')
    RETURNING id INTO v_notif_id;

    RETURN jsonb_build_object(
      'user_id', v_emp.user_id,
      'organization_id', v_req.organization_id,
      'business_id', v_emp.business_id,
      'category', 'hr',
      'title', v_title,
      'message', v_message,
      'link', '/me/profile',
      'entity_type', 'employee_profile_change_request',
      'entity_id', v_req.id,
      'notification_id', v_notif_id
    );
  END IF;

  RETURN jsonb_build_object('skipped', true, 'reason', 'no_user_link');
END;
$$;

REVOKE ALL ON FUNCTION public.review_profile_change_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_profile_change_request(uuid, text, text) TO authenticated;