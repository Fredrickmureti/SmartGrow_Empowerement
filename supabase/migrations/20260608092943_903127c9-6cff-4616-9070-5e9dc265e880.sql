
CREATE OR REPLACE FUNCTION public.notify_attendance_decision(
  _employee_id uuid,
  _decision text,
  _kind text,
  _note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid;
  _org_id uuid;
  _biz_id uuid;
  _title text;
  _message text;
BEGIN
  IF _employee_id IS NULL THEN RETURN; END IF;

  SELECT user_id, organization_id, business_id
    INTO _user_id, _org_id, _biz_id
  FROM public.employees
  WHERE id = _employee_id;

  IF _user_id IS NULL OR _org_id IS NULL THEN RETURN; END IF;

  _title := CASE
    WHEN _kind = 'correction' AND _decision = 'approved' THEN 'Attendance correction approved'
    WHEN _kind = 'correction' AND _decision = 'rejected' THEN 'Attendance correction rejected'
    WHEN _kind = 'overtime'   AND _decision = 'approved' THEN 'Overtime request approved'
    WHEN _kind = 'overtime'   AND _decision = 'rejected' THEN 'Overtime request rejected'
    ELSE 'Attendance update'
  END;

  _message := CASE
    WHEN _note IS NOT NULL AND length(trim(_note)) > 0 THEN _title || ': ' || _note
    ELSE _title
  END;

  INSERT INTO public.notifications (
    organization_id, business_id, user_id,
    type, category, title, message, link, entity_type, priority
  ) VALUES (
    _org_id, _biz_id, _user_id,
    CASE WHEN _decision = 'approved' THEN 'success' ELSE 'warning' END,
    'attendance', _title, _message, '/me/attendance/requests',
    _kind, 1
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_attendance_decision(uuid, text, text, text) TO authenticated;

-- Trigger: attendance_corrections decision -> notify
CREATE OR REPLACE FUNCTION public.trg_notify_correction_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status IN ('approved','rejected')
     AND (OLD.status = 'pending' OR OLD.status IS NULL) THEN
    PERFORM public.notify_attendance_decision(
      NEW.employee_id, NEW.status, 'correction', NEW.review_note
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_correction_decision ON public.attendance_corrections;
CREATE TRIGGER notify_correction_decision
AFTER UPDATE ON public.attendance_corrections
FOR EACH ROW EXECUTE FUNCTION public.trg_notify_correction_decision();

-- Trigger: overtime_requests decision -> notify
CREATE OR REPLACE FUNCTION public.trg_notify_overtime_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status IN ('approved','rejected')
     AND (OLD.status = 'pending' OR OLD.status IS NULL) THEN
    PERFORM public.notify_attendance_decision(
      NEW.employee_id, NEW.status, 'overtime', NEW.review_note
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_overtime_decision ON public.overtime_requests;
CREATE TRIGGER notify_overtime_decision
AFTER UPDATE ON public.overtime_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_notify_overtime_decision();
