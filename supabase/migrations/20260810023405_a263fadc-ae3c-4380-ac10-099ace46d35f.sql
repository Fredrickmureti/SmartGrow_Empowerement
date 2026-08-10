CREATE TABLE public.collector_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  collector_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, contact_id, collector_user_id, active)
);

CREATE INDEX collector_assignments_org_contact
  ON public.collector_assignments (organization_id, contact_id)
  WHERE active = true;

CREATE INDEX collector_assignments_collector
  ON public.collector_assignments (collector_user_id)
  WHERE active = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.collector_assignments TO authenticated;
GRANT ALL ON public.collector_assignments TO service_role;

ALTER TABLE public.collector_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view collector assignments"
  ON public.collector_assignments
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Org members can manage collector assignments"
  ON public.collector_assignments
  FOR ALL TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

CREATE TRIGGER collector_assignments_touch
  BEFORE UPDATE ON public.collector_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.collector_assignments IS 'Maps customers (contacts) to the staff member responsible for collecting their outstanding receivables. Only one active assignment per (contact, collector) pair.';

CREATE OR REPLACE FUNCTION public.upsert_collector_assignment(
  _contact_id uuid,
  _collector_user_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _assignment_id uuid;
BEGIN
  SELECT organization_id INTO _org_id FROM public.contacts WHERE id = _contact_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Contact % not found', _contact_id;
  END IF;

  IF NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;

  UPDATE public.collector_assignments
  SET active = false, deactivated_at = now(), deactivated_by = auth.uid(), updated_at = now()
  WHERE contact_id = _contact_id AND active = true;

  INSERT INTO public.collector_assignments (organization_id, business_id, contact_id, collector_user_id, assigned_by)
  VALUES (_org_id, _business_id, _contact_id, _collector_user_id, auth.uid())
  ON CONFLICT (organization_id, contact_id, collector_user_id, active) DO UPDATE
    SET active = true, assigned_by = auth.uid(), assigned_at = now(),
        deactivated_at = NULL, deactivated_by = NULL, updated_at = now()
  RETURNING id INTO _assignment_id;

  RETURN _assignment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_collector_assignment(uuid, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.deactivate_collector_assignment(
  _contact_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.collector_assignments
  SET active = false, deactivated_at = now(), deactivated_by = auth.uid(), updated_at = now()
  WHERE contact_id = _contact_id AND active = true
    AND public.is_org_member(auth.uid(), organization_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.deactivate_collector_assignment(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';