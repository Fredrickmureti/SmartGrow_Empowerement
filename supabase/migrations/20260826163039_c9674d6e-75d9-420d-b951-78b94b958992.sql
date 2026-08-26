
CREATE OR REPLACE FUNCTION public.normalize_profile_change_value(p_field_key text, p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := p_raw;
  v_word text;
  v_out text[] := '{}';
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;

  v := btrim(v);
  -- strip any number of wrapping double/single quotes left by double JSON encoding
  WHILE length(v) >= 2
    AND ((left(v,1) = '"' AND right(v,1) = '"') OR (left(v,1) = '''' AND right(v,1) = ''''))
  LOOP
    v := btrim(substr(v, 2, length(v) - 2));
  END LOOP;

  v := regexp_replace(v, '\s+', ' ', 'g');

  IF p_field_key IN ('first_name','last_name','middle_name','preferred_name','other_names') THEN
    FOREACH v_word IN ARRAY regexp_split_to_array(v, ' ') LOOP
      -- only fix words that are entirely lower case; preserve McDonald, O'Brien-style casing
      IF v_word = lower(v_word) AND v_word <> '' THEN
        v_out := v_out || (upper(left(v_word,1)) || substr(v_word,2));
      ELSE
        v_out := v_out || v_word;
      END IF;
    END LOOP;
    v := array_to_string(v_out, ' ');
  END IF;

  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_profile_change_value(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_profile_change_value(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_profile_change_request(p_request_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req record;
  v_emp record;
  v_event_type public.employee_lifecycle_event_type;
  v_old_txt text;
  v_new_txt text;
  v_applied text;
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

  v_applied := public.normalize_profile_change_value(v_req.field_key, v_req.new_value #>> '{}');

  UPDATE public.employee_profile_change_requests SET
    status = p_decision,
    new_value = CASE WHEN v_applied IS NULL THEN new_value ELSE to_jsonb(v_applied) END,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = p_note,
    updated_at = now()
  WHERE id = p_request_id;

  IF p_decision = 'approved' THEN
    EXECUTE format(
      'UPDATE public.employees SET %I = $1, updated_at = now() WHERE id = $2',
      v_req.field_key
    ) USING v_applied, v_req.employee_id;
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
                        'new_value', to_jsonb(v_applied),
                        'decision', p_decision,
                        'note', p_note));

  v_old_txt := COALESCE(NULLIF(public.normalize_profile_change_value(v_req.field_key, v_req.old_value #>> '{}'), ''), '(empty)');
  v_new_txt := COALESCE(NULLIF(v_applied, ''), '(empty)');
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
$function$;

-- Repair existing double-encoded request rows
UPDATE public.employee_profile_change_requests
   SET new_value = to_jsonb(public.normalize_profile_change_value(field_key, new_value #>> '{}')),
       updated_at = now()
 WHERE jsonb_typeof(new_value) = 'string'
   AND (new_value #>> '{}') IS DISTINCT FROM public.normalize_profile_change_value(field_key, new_value #>> '{}');

UPDATE public.employee_profile_change_requests
   SET old_value = to_jsonb(public.normalize_profile_change_value(field_key, old_value #>> '{}'))
 WHERE jsonb_typeof(old_value) = 'string'
   AND (old_value #>> '{}') IS DISTINCT FROM public.normalize_profile_change_value(field_key, old_value #>> '{}');

-- Repair already-applied employee values
UPDATE public.employees
   SET first_name = public.normalize_profile_change_value('first_name', first_name),
       updated_at = now()
 WHERE first_name IS DISTINCT FROM public.normalize_profile_change_value('first_name', first_name);

UPDATE public.employees
   SET last_name = public.normalize_profile_change_value('last_name', last_name),
       updated_at = now()
 WHERE last_name IS DISTINCT FROM public.normalize_profile_change_value('last_name', last_name);

UPDATE public.employees
   SET bank_account_number = public.normalize_profile_change_value('bank_account_number', bank_account_number),
       updated_at = now()
 WHERE bank_account_number IS DISTINCT FROM public.normalize_profile_change_value('bank_account_number', bank_account_number);

UPDATE public.employees
   SET bank_name = public.normalize_profile_change_value('bank_name', bank_name),
       updated_at = now()
 WHERE bank_name IS DISTINCT FROM public.normalize_profile_change_value('bank_name', bank_name);
