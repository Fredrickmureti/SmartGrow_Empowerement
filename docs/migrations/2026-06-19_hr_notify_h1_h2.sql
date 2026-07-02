-- ============================================================================
-- HR notification waves H1 + H2 (RPC layer)
-- Apply via the Lovable migration tool. Pure schema/function changes; no DML.
-- ============================================================================
--
-- H1: dedupe + per-channel preference-aware payload (returns `channels`)
-- H2: leave/OT/correction/swap lifecycle coverage — adds employee
--     confirmation on submit and a new `pending_second_approval` event
--     used by two-tier leave policies.
-- H3: client hooks already dispatch (see src/hooks/...), but rely on the
--     RPC's `requester_employee_id` lookup for shift_swap_request which
--     prior RPC left NULL.

-- ----------------------------------------------------------------------------
-- 1) Dedupe index: one delivery_log row per (org, entity, event, user, channel)
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_delivery_log_idem
  ON public.notification_delivery_log
  (organization_id, entity_type, entity_id, event, user_id, channel)
  WHERE entity_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) Replace hr_notify_approval_event
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.hr_notify_approval_event(text, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.hr_notify_approval_event(
  _entity_type text,
  _entity_id uuid,
  _event text,
  _actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_employee_id uuid;
  v_emp_user uuid;
  v_manager_id uuid;
  v_manager_user uuid;
  v_module text;
  v_category text;
  v_title text;
  v_message text;
  v_link_inbound text;
  v_link_outbound text;
  v_link text;
  v_outbound boolean;
  v_employee_confirm boolean;
  v_notices jsonb := '[]'::jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_recip uuid;
  v_first_name text;
  v_last_name text;
  v_actor_label text;
  v_type text := 'info';
  v_priority int := 0;
  v_email_enabled boolean;
  v_in_app_enabled boolean;
  v_emp_title text;
  v_emp_message text;
  r record;
BEGIN
  IF _entity_id IS NULL OR _entity_type IS NULL OR _event IS NULL THEN
    RETURN v_notices;
  END IF;

  CASE _entity_type
    WHEN 'leave_request' THEN
      SELECT lr.organization_id, lr.business_id, lr.employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.leave_requests lr WHERE lr.id = _entity_id;
      v_category := 'leave'; v_module := 'hr';
    WHEN 'timesheet_submission' THEN
      SELECT ts.organization_id, ts.business_id, ts.employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.timesheet_submissions ts WHERE ts.id = _entity_id;
      v_category := 'timesheet'; v_module := 'hr';
    WHEN 'overtime_request' THEN
      SELECT o.organization_id, o.business_id, o.employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.overtime_requests o WHERE o.id = _entity_id;
      v_category := 'overtime'; v_module := 'hr';
    WHEN 'shift_swap_request' THEN
      SELECT s.organization_id, s.business_id, s.requester_employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.shift_swap_requests s WHERE s.id = _entity_id;
      v_category := 'shift_swap'; v_module := 'hr';
    WHEN 'attendance_correction' THEN
      SELECT a.organization_id, a.business_id, a.employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.attendance_corrections a WHERE a.id = _entity_id;
      v_category := 'attendance'; v_module := 'hr';
    WHEN 'expense' THEN
      SELECT e.organization_id, e.business_id, e.employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.expenses e WHERE e.id = _entity_id;
      v_category := 'expense'; v_module := 'expenses';
    WHEN 'employee_loan' THEN
      SELECT l.organization_id, l.business_id, l.employee_id
        INTO v_org, v_biz, v_employee_id
      FROM public.employee_loans l WHERE l.id = _entity_id;
      v_category := 'loan'; v_module := 'payroll';
    ELSE
      RETURN v_notices;
  END CASE;

  IF v_org IS NULL THEN RETURN v_notices; END IF;

  IF v_employee_id IS NOT NULL THEN
    SELECT e.user_id, e.manager_id, e.first_name, e.last_name
      INTO v_emp_user, v_manager_id, v_first_name, v_last_name
    FROM public.employees e WHERE e.id = v_employee_id;

    IF v_manager_id IS NOT NULL THEN
      SELECT e.user_id INTO v_manager_user
      FROM public.employees e WHERE e.id = v_manager_id;
    END IF;
  END IF;

  v_actor_label := trim(coalesce(v_first_name, '') || ' ' || coalesce(v_last_name, ''));
  IF v_actor_label = '' THEN v_actor_label := 'An employee'; END IF;

  v_outbound := _event IN ('approved','rejected','cancelled','disbursed');
  v_employee_confirm := _event IN ('submitted','requested','pending_second_approval');

  CASE _event
    WHEN 'submitted','requested' THEN
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' submitted';
      v_message := v_actor_label || ' submitted a ' || replace(_entity_type, '_', ' ') || ' for review.';
      v_emp_title := initcap(replace(_entity_type, '_', ' ')) || ' submitted';
      v_emp_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has been submitted for approval.';
      v_type := 'info'; v_priority := 1;
    WHEN 'pending_second_approval' THEN
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' awaiting final approval';
      v_message := v_actor_label || '''s ' || replace(_entity_type, '_', ' ') || ' has first-level approval and awaits final approval.';
      v_emp_title := v_title;
      v_emp_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has first-level approval and is awaiting final approval.';
      v_type := 'info'; v_priority := 2;
    WHEN 'approved' THEN
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' approved';
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has been approved.';
      v_emp_title := v_title; v_emp_message := v_message;
      v_type := 'success';
    WHEN 'rejected' THEN
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' rejected';
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' was rejected.';
      v_emp_title := v_title; v_emp_message := v_message;
      v_type := 'error'; v_priority := 1;
    WHEN 'cancelled' THEN
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' cancelled';
      v_message := 'A ' || replace(_entity_type, '_', ' ') || ' has been cancelled.';
      v_emp_title := v_title; v_emp_message := v_message;
      v_type := 'warning';
    WHEN 'disbursed' THEN
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' disbursed';
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has been disbursed.';
      v_emp_title := v_title; v_emp_message := v_message;
      v_type := 'success';
    ELSE
      v_title := initcap(replace(_entity_type, '_', ' ')) || ' update';
      v_message := 'Update on your ' || replace(_entity_type, '_', ' ') || '.';
      v_emp_title := v_title; v_emp_message := v_message;
  END CASE;

  v_link_inbound := CASE _entity_type
    WHEN 'leave_request' THEN '/hr/leave'
    WHEN 'timesheet_submission' THEN '/hr/timesheets'
    WHEN 'overtime_request' THEN '/hr/overtime'
    WHEN 'shift_swap_request' THEN '/hr/shifts'
    WHEN 'attendance_correction' THEN '/hr/attendance'
    WHEN 'expense' THEN '/expenses'
    WHEN 'employee_loan' THEN '/hr/payroll/loans'
    ELSE NULL
  END;
  v_link_outbound := CASE _entity_type
    WHEN 'leave_request' THEN '/me/leave'
    WHEN 'timesheet_submission' THEN '/me/timesheets'
    WHEN 'overtime_request' THEN '/me/attendance'
    WHEN 'shift_swap_request' THEN '/me/shifts'
    WHEN 'attendance_correction' THEN '/me/attendance'
    WHEN 'expense' THEN '/me/expenses'
    WHEN 'employee_loan' THEN '/me/loans'
    ELSE NULL
  END;

  -- Employee-targeted path (outbound terminal events OR confirmation on submit)
  IF (v_outbound OR v_employee_confirm) AND v_emp_user IS NOT NULL
     AND (_actor IS NULL OR v_emp_user <> _actor) THEN
    v_link := v_link_outbound;
    v_recip := v_emp_user;

    SELECT coalesce(np.in_app_enabled, true), coalesce(np.email_enabled, true)
      INTO v_in_app_enabled, v_email_enabled
    FROM public.notification_preferences np
    WHERE np.user_id = v_recip AND np.organization_id = v_org AND np.category = v_category
    LIMIT 1;
    v_in_app_enabled := coalesce(v_in_app_enabled, true);
    v_email_enabled  := coalesce(v_email_enabled, true);

    IF v_in_app_enabled THEN
      PERFORM public.create_notification(
        v_org, v_recip, v_type, v_category, v_emp_title, v_emp_message,
        v_link, _entity_type, _entity_id, v_priority, v_biz
      );
      INSERT INTO public.notification_delivery_log
        (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status)
        VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'sent')
      ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_log
        (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status, suppressed_reason)
        VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'suppressed', 'pref_disabled')
      ON CONFLICT DO NOTHING;
    END IF;

    v_notices := v_notices || jsonb_build_object(
      'user_id', v_recip, 'category', v_category,
      'title', v_emp_title, 'message', v_emp_message,
      'link', v_link, 'entity_type', _entity_type, 'entity_id', _entity_id,
      'business_id', v_biz,
      'channels', jsonb_build_object('in_app', v_in_app_enabled, 'email', v_email_enabled)
    );
    v_seen := array_append(v_seen, v_recip);
  END IF;

  -- Inbound path: notify approvers (manager + module write)
  IF NOT v_outbound THEN
    v_link := v_link_inbound;

    IF v_manager_user IS NOT NULL
       AND (_actor IS NULL OR v_manager_user <> _actor)
       AND NOT (v_manager_user = ANY(v_seen)) THEN
      v_recip := v_manager_user;

      SELECT coalesce(np.in_app_enabled, true), coalesce(np.email_enabled, true)
        INTO v_in_app_enabled, v_email_enabled
      FROM public.notification_preferences np
      WHERE np.user_id = v_recip AND np.organization_id = v_org AND np.category = v_category
      LIMIT 1;
      v_in_app_enabled := coalesce(v_in_app_enabled, true);
      v_email_enabled  := coalesce(v_email_enabled, true);

      IF v_in_app_enabled THEN
        PERFORM public.create_notification(
          v_org, v_recip, v_type, v_category, v_title, v_message,
          v_link, _entity_type, _entity_id, v_priority, v_biz
        );
        INSERT INTO public.notification_delivery_log
          (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status)
          VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'sent')
        ON CONFLICT DO NOTHING;
      ELSE
        INSERT INTO public.notification_delivery_log
          (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status, suppressed_reason)
          VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'suppressed', 'pref_disabled')
        ON CONFLICT DO NOTHING;
      END IF;

      v_notices := v_notices || jsonb_build_object(
        'user_id', v_recip, 'category', v_category, 'title', v_title, 'message', v_message,
        'link', v_link, 'entity_type', _entity_type, 'entity_id', _entity_id, 'business_id', v_biz,
        'channels', jsonb_build_object('in_app', v_in_app_enabled, 'email', v_email_enabled)
      );
      v_seen := array_append(v_seen, v_recip);
    END IF;

    FOR r IN
      SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
      WHERE ur.organization_id = v_org
        AND ur.is_active = true
        AND ur.user_id IS NOT NULL
        AND public.user_has_module_permission(ur.user_id, v_org, v_module, 'write')
    LOOP
      v_recip := r.user_id;
      IF _actor IS NOT NULL AND v_recip = _actor THEN CONTINUE; END IF;
      IF v_recip = ANY(v_seen) THEN CONTINUE; END IF;

      SELECT coalesce(np.in_app_enabled, true), coalesce(np.email_enabled, true)
        INTO v_in_app_enabled, v_email_enabled
      FROM public.notification_preferences np
      WHERE np.user_id = v_recip AND np.organization_id = v_org AND np.category = v_category
      LIMIT 1;
      v_in_app_enabled := coalesce(v_in_app_enabled, true);
      v_email_enabled  := coalesce(v_email_enabled, true);

      IF v_in_app_enabled THEN
        PERFORM public.create_notification(
          v_org, v_recip, v_type, v_category, v_title, v_message,
          v_link, _entity_type, _entity_id, v_priority, v_biz
        );
        INSERT INTO public.notification_delivery_log
          (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status)
          VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'sent')
        ON CONFLICT DO NOTHING;
      ELSE
        INSERT INTO public.notification_delivery_log
          (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status, suppressed_reason)
          VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'suppressed', 'pref_disabled')
        ON CONFLICT DO NOTHING;
      END IF;

      v_notices := v_notices || jsonb_build_object(
        'user_id', v_recip, 'category', v_category, 'title', v_title, 'message', v_message,
        'link', v_link, 'entity_type', _entity_type, 'entity_id', _entity_id, 'business_id', v_biz,
        'channels', jsonb_build_object('in_app', v_in_app_enabled, 'email', v_email_enabled)
      );
      v_seen := array_append(v_seen, v_recip);
    END LOOP;
  END IF;

  RETURN v_notices;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.hr_notify_approval_event(text, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_notify_approval_event(text, uuid, text, uuid) TO service_role;
