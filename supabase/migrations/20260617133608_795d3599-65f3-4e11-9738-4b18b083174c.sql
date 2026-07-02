
-- Optional FK linking attendance_devices to canonical device_assignments.
-- Nullable: legacy rows pre-date the registry; new biometric units should
-- populate this so admins see one device per physical unit.
ALTER TABLE public.attendance_devices
  ADD COLUMN IF NOT EXISTS device_assignment_id uuid NULL
    REFERENCES public.device_assignments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS attendance_devices_assignment_idx
  ON public.attendance_devices (device_assignment_id);

-- Emit clock-in / clock-out into business_event_outbox so downstream
-- handlers (payroll work-entry hooks, kiosk customer-display refresh,
-- supervisor SMS) drain the same durable channel as inventory events.
CREATE OR REPLACE FUNCTION public.tg_attendance_event_emit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
BEGIN
  -- Only act on terminal clock events with an accepted decision.
  IF NEW.event_type IN ('clock_in','clock_out','check_in','check_out')
     AND COALESCE(NEW.decision, '') IN ('approved','accepted','recorded') THEN

    v_kind := CASE
      WHEN NEW.event_type IN ('clock_in','check_in')  THEN 'attendance.clock_in'
      WHEN NEW.event_type IN ('clock_out','check_out') THEN 'attendance.clock_out'
    END;

    PERFORM public.publish_business_event(
      NEW.organization_id,
      NEW.branch_id,
      NULL,
      v_kind,
      'attendance_event',
      NEW.id,
      jsonb_build_object(
        'employee_id', NEW.employee_id,
        'attendance_id', NEW.attendance_id,
        'event_type', NEW.event_type,
        'source', NEW.source,
        'device_fingerprint', NEW.device_fingerprint
      ),
      'att-evt:' || NEW.id::text,
      NEW.created_by
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_events_emit ON public.attendance_events;
CREATE TRIGGER attendance_events_emit
  AFTER INSERT ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_attendance_event_emit();
