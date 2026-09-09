CREATE TABLE public.mf_meeting_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES public.mf_group_meetings(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.mf_clients(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'present'
    CHECK (status IN ('present','absent','excused')),
  note text,
  recorded_by uuid DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_meeting_attendance_unique UNIQUE (meeting_id, client_id)
);

CREATE INDEX mf_meeting_attendance_meeting_idx
  ON public.mf_meeting_attendance (meeting_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_meeting_attendance TO authenticated;
GRANT ALL ON public.mf_meeting_attendance TO service_role;

ALTER TABLE public.mf_meeting_attendance ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_meeting_attendance_read ON public.mf_meeting_attendance
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mf_group_meetings m
     WHERE m.id = mf_meeting_attendance.meeting_id
       AND public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'read', m.loan_officer_id)));

CREATE POLICY mf_meeting_attendance_insert ON public.mf_meeting_attendance
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.mf_group_meetings m
     WHERE m.id = mf_meeting_attendance.meeting_id
       AND public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'create', m.loan_officer_id)));

CREATE POLICY mf_meeting_attendance_update ON public.mf_meeting_attendance
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mf_group_meetings m
     WHERE m.id = mf_meeting_attendance.meeting_id
       AND public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'write', m.loan_officer_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.mf_group_meetings m
     WHERE m.id = mf_meeting_attendance.meeting_id
       AND public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'write', m.loan_officer_id)));

CREATE POLICY mf_meeting_attendance_delete ON public.mf_meeting_attendance
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mf_group_meetings m
     WHERE m.id = mf_meeting_attendance.meeting_id
       AND public.mf_can_scoped(m.business_id, m.branch_id, 'clients', 'write', m.loan_officer_id)));

CREATE OR REPLACE FUNCTION public._mf_meeting_attendance_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_group uuid;
  v_status text;
BEGIN
  SELECT m.group_id, m.status INTO v_group, v_status
    FROM public.mf_group_meetings m WHERE m.id = NEW.meeting_id;
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'This meeting does not exist';
  END IF;
  IF v_status IN ('completed','missed') THEN
    RAISE EXCEPTION 'This meeting is already closed; attendance can no longer be changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.mf_group_members gm
     WHERE gm.group_id = v_group AND gm.client_id = NEW.client_id AND gm.is_active
  ) THEN
    RAISE EXCEPTION 'This client is not an active member of the group meeting';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_meeting_attendance_guard
  BEFORE INSERT OR UPDATE ON public.mf_meeting_attendance
  FOR EACH ROW EXECUTE FUNCTION public._mf_meeting_attendance_guard();

CREATE TRIGGER mf_meeting_attendance_touch
  BEFORE UPDATE ON public.mf_meeting_attendance
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();