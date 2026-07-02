-- Fix: the timesheets app-installed trigger was incorrectly checking for 'attendance'
-- instead of 'timesheets'. This caused writes to fail when only Timesheets was installed.
DROP TRIGGER IF EXISTS trg_timesheets_app_installed ON public.timesheets;
CREATE TRIGGER trg_timesheets_app_installed
  BEFORE INSERT OR DELETE OR UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION assert_app_installed_for_write('timesheets');

-- Notification trigger: fires on timesheet_submissions insert/update to create
-- in-app notifications for the relevant parties.
CREATE OR REPLACE FUNCTION public.trg_timesheet_submission_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_emp record;
  v_manager_user_id uuid;
  v_title text;
  v_message text;
  v_recipient_id uuid;
BEGIN
  -- Look up the employee and their manager
  SELECT e.*, m.user_id AS manager_uid
    INTO v_emp
    FROM public.employees e
    LEFT JOIN public.employees m ON m.id = e.manager_id
   WHERE e.id = NEW.employee_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  v_manager_user_id := v_emp.manager_uid;

  IF TG_OP = 'INSERT' AND NEW.status = 'submitted' THEN
    -- Notify manager when employee submits
    v_title := 'Timesheet submitted for approval';
    v_message := format('%s %s submitted timesheets for %s – %s (%sh)',
      v_emp.first_name, v_emp.last_name,
      NEW.period_start, NEW.period_end, NEW.total_hours);

    IF v_manager_user_id IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, organization_id, title, message, type, link)
      VALUES (v_manager_user_id, NEW.organization_id, v_title, v_message, 'timesheet', '/timesheets/approvals');
    END IF;

  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'submitted' AND NEW.status = 'approved' THEN
    -- Notify employee when approved
    IF v_emp.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, organization_id, title, message, type, link)
      VALUES (v_emp.user_id, NEW.organization_id,
        'Timesheet approved',
        format('Your timesheet for %s – %s has been approved.', NEW.period_start, NEW.period_end),
        'timesheet', '/timesheets');
    END IF;

  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'submitted' AND NEW.status = 'rejected' THEN
    -- Notify employee when rejected
    IF v_emp.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, organization_id, title, message, type, link)
      VALUES (v_emp.user_id, NEW.organization_id,
        'Timesheet rejected',
        format('Your timesheet for %s – %s was rejected: %s', NEW.period_start, NEW.period_end, COALESCE(NEW.rejection_reason, 'No reason provided')),
        'timesheet', '/timesheets');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_timesheet_submission_notify ON public.timesheet_submissions;
CREATE TRIGGER trg_timesheet_submission_notify
  AFTER INSERT OR UPDATE ON public.timesheet_submissions
  FOR EACH ROW EXECUTE FUNCTION trg_timesheet_submission_notify();