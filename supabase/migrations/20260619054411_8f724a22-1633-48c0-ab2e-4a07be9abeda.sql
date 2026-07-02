
-- 1) Notification delivery log (audit trail of comms attempts)
CREATE TABLE IF NOT EXISTS public.notification_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  user_id uuid NOT NULL,
  category text NOT NULL,
  entity_type text,
  entity_id uuid,
  event text NOT NULL,
  channel text NOT NULL,            -- 'in_app' | 'email' | 'sms'
  status text NOT NULL,             -- 'sent' | 'suppressed' | 'failed'
  suppressed_reason text,           -- 'pref_disabled' | 'no_email' | 'no_phone' | etc.
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.notification_delivery_log TO authenticated;
GRANT ALL ON public.notification_delivery_log TO service_role;

ALTER TABLE public.notification_delivery_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own delivery log"
  ON public.notification_delivery_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role manages delivery log"
  ON public.notification_delivery_log FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_notif_delivery_log_org_entity
  ON public.notification_delivery_log (organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notif_delivery_log_user
  ON public.notification_delivery_log (user_id, created_at DESC);

-- 2) Shared HR approval-event notification RPC
-- Resolves recipients per entity_type and event, inserts in-app notifications
-- (honouring notification_preferences.in_app_enabled), logs delivery, and
-- returns the recipient list so the client can fan-out emails through the
-- existing send-notification-email edge function.
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
  v_link text;
  v_outbound boolean;
  v_notices jsonb := '[]'::jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_recip uuid;
  v_first_name text;
  v_last_name text;
  v_actor_label text;
  v_type text := 'info';
  v_priority int := 0;
  r record;
BEGIN
  IF _entity_id IS NULL OR _entity_type IS NULL OR _event IS NULL THEN
    RETURN v_notices;
  END IF;

  -- Resolve the entity → org, business, employee, manager, category, module
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
      SELECT s.organization_id, s.business_id, NULL::uuid
        INTO v_org, v_biz, v_employee_id
      FROM public.shift_swap_requests s WHERE s.id = _entity_id;
      -- shift_swap_requests doesn't carry employee_id; resolve via requester employee row if linked
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

  IF v_org IS NULL THEN
    RETURN v_notices;
  END IF;

  -- Employee context
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

  -- Compose title/message/link by (entity, event)
  v_outbound := _event IN ('approved','rejected','cancelled','disbursed');

  v_title := initcap(replace(_entity_type, '_', ' ')) || ' ' || _event;
  CASE _event
    WHEN 'submitted','requested' THEN
      v_message := v_actor_label || ' submitted a ' || replace(_entity_type, '_', ' ') || ' for review.';
      v_type := 'info'; v_priority := 1;
    WHEN 'approved' THEN
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has been approved.';
      v_type := 'success';
    WHEN 'rejected' THEN
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' was rejected.';
      v_type := 'error'; v_priority := 1;
    WHEN 'cancelled' THEN
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has been cancelled.';
      v_type := 'warning';
    WHEN 'disbursed' THEN
      v_message := 'Your ' || replace(_entity_type, '_', ' ') || ' has been disbursed.';
      v_type := 'success';
    ELSE
      v_message := 'Update on your ' || replace(_entity_type, '_', ' ') || '.';
  END CASE;

  -- Link to approver-side review page or self-service detail
  v_link := CASE _entity_type
    WHEN 'leave_request' THEN CASE WHEN v_outbound THEN '/me/leave' ELSE '/hr/leave' END
    WHEN 'timesheet_submission' THEN CASE WHEN v_outbound THEN '/me/attendance' ELSE '/hr/timesheets' END
    WHEN 'overtime_request' THEN CASE WHEN v_outbound THEN '/me/attendance' ELSE '/hr/overtime' END
    WHEN 'shift_swap_request' THEN CASE WHEN v_outbound THEN '/me/shifts' ELSE '/hr/shifts' END
    WHEN 'attendance_correction' THEN CASE WHEN v_outbound THEN '/me/attendance' ELSE '/hr/attendance' END
    WHEN 'expense' THEN CASE WHEN v_outbound THEN '/me/expenses' ELSE '/expenses' END
    WHEN 'employee_loan' THEN CASE WHEN v_outbound THEN '/me/loans' ELSE '/hr/payroll/loans' END
    ELSE NULL
  END;

  -- Recipient resolution
  IF v_outbound THEN
    -- Notify the employee
    IF v_emp_user IS NULL THEN
      RETURN v_notices;
    END IF;
    v_recip := v_emp_user;
    IF _actor IS NULL OR v_recip <> _actor THEN
      PERFORM public.create_notification(
        v_org, v_recip, v_type, v_category, v_title, v_message,
        v_link, _entity_type, _entity_id, v_priority, v_biz
      );
      INSERT INTO public.notification_delivery_log
        (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status)
        VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'sent');
      v_notices := v_notices || jsonb_build_object(
        'user_id', v_recip, 'category', v_category, 'title', v_title, 'message', v_message,
        'link', v_link, 'entity_type', _entity_type, 'entity_id', _entity_id, 'business_id', v_biz
      );
    END IF;
  ELSE
    -- Inbound: manager + module approvers, exclude actor and duplicates
    IF v_manager_user IS NOT NULL AND (_actor IS NULL OR v_manager_user <> _actor) THEN
      PERFORM public.create_notification(
        v_org, v_manager_user, v_type, v_category, v_title, v_message,
        v_link, _entity_type, _entity_id, v_priority, v_biz
      );
      INSERT INTO public.notification_delivery_log
        (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status)
        VALUES (v_org, v_biz, v_manager_user, v_category, _entity_type, _entity_id, _event, 'in_app', 'sent');
      v_notices := v_notices || jsonb_build_object(
        'user_id', v_manager_user, 'category', v_category, 'title', v_title, 'message', v_message,
        'link', v_link, 'entity_type', _entity_type, 'entity_id', _entity_id, 'business_id', v_biz
      );
      v_seen := array_append(v_seen, v_manager_user);
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
      PERFORM public.create_notification(
        v_org, v_recip, v_type, v_category, v_title, v_message,
        v_link, _entity_type, _entity_id, v_priority, v_biz
      );
      INSERT INTO public.notification_delivery_log
        (organization_id, business_id, user_id, category, entity_type, entity_id, event, channel, status)
        VALUES (v_org, v_biz, v_recip, v_category, _entity_type, _entity_id, _event, 'in_app', 'sent');
      v_notices := v_notices || jsonb_build_object(
        'user_id', v_recip, 'category', v_category, 'title', v_title, 'message', v_message,
        'link', v_link, 'entity_type', _entity_type, 'entity_id', _entity_id, 'business_id', v_biz
      );
      v_seen := array_append(v_seen, v_recip);
    END LOOP;
  END IF;

  RETURN v_notices;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.hr_notify_approval_event(text, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_notify_approval_event(text, uuid, text, uuid) TO service_role;

-- 3) Loan-disbursement trigger fallback (server-side payroll batches)
CREATE OR REPLACE FUNCTION public.tg_employee_loan_disbursed_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tg$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND NEW.status = 'disbursed'
     AND (OLD.status IS DISTINCT FROM 'disbursed') THEN
    PERFORM public.hr_notify_approval_event(
      'employee_loan', NEW.id, 'disbursed', NULL
    );
  END IF;
  RETURN NEW;
END;
$tg$;

DROP TRIGGER IF EXISTS trg_employee_loan_disbursed_notify ON public.employee_loans;
CREATE TRIGGER trg_employee_loan_disbursed_notify
  AFTER UPDATE OF status ON public.employee_loans
  FOR EACH ROW EXECUTE FUNCTION public.tg_employee_loan_disbursed_notify();
