CREATE TABLE public.mf_group_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid,
  group_id uuid NOT NULL REFERENCES public.mf_groups(id) ON DELETE RESTRICT,
  loan_officer_id uuid,
  scheduled_on date NOT NULL,
  scheduled_time time without time zone,
  meeting_place text,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','completed','postponed','missed')),
  opened_at timestamptz,
  opened_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  notes text,
  postponed_to date,
  next_scheduled_on date,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_group_meetings_unique_per_day UNIQUE (group_id, scheduled_on)
);

CREATE INDEX mf_group_meetings_scope_idx
  ON public.mf_group_meetings (business_id, branch_id, scheduled_on);
CREATE INDEX mf_group_meetings_officer_idx
  ON public.mf_group_meetings (loan_officer_id, scheduled_on);

GRANT SELECT, INSERT, UPDATE ON public.mf_group_meetings TO authenticated;
GRANT ALL ON public.mf_group_meetings TO service_role;

ALTER TABLE public.mf_group_meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_group_meetings_read ON public.mf_group_meetings
  FOR SELECT TO authenticated
  USING (public.mf_can_scoped(business_id, branch_id, 'clients', 'read', loan_officer_id));

CREATE POLICY mf_group_meetings_insert ON public.mf_group_meetings
  FOR INSERT TO authenticated
  WITH CHECK (public.mf_can_scoped(business_id, branch_id, 'clients', 'create', loan_officer_id));

CREATE POLICY mf_group_meetings_update ON public.mf_group_meetings
  FOR UPDATE TO authenticated
  USING (public.mf_can_scoped(business_id, branch_id, 'clients', 'write', loan_officer_id))
  WITH CHECK (public.mf_can_scoped(business_id, branch_id, 'clients', 'write', loan_officer_id));

CREATE OR REPLACE FUNCTION public._mf_group_meeting_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  g record;
BEGIN
  SELECT business_id, branch_id INTO g FROM public.mf_groups WHERE id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The group for this meeting does not exist';
  END IF;
  IF NEW.business_id IS DISTINCT FROM g.business_id THEN
    RAISE EXCEPTION 'A meeting must belong to the same business as its group';
  END IF;
  IF NEW.branch_id IS DISTINCT FROM g.branch_id THEN
    RAISE EXCEPTION 'A meeting must belong to the same branch as its group';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_group_meetings_scope_guard
  BEFORE INSERT OR UPDATE ON public.mf_group_meetings
  FOR EACH ROW EXECUTE FUNCTION public._mf_group_meeting_scope_guard();

CREATE TRIGGER mf_group_meetings_touch
  BEFORE UPDATE ON public.mf_group_meetings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();