CREATE TABLE public.consolidation_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  parent_business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  presentation_currency text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX consolidation_groups_org_name_key
  ON public.consolidation_groups (organization_id, lower(name));
CREATE INDEX consolidation_groups_org_idx
  ON public.consolidation_groups (organization_id) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_groups TO authenticated;
GRANT ALL ON public.consolidation_groups TO service_role;

ALTER TABLE public.consolidation_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_groups_select ON public.consolidation_groups
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id)
         AND public.user_can_access_business(auth.uid(), parent_business_id));

CREATE POLICY consolidation_groups_write ON public.consolidation_groups
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), parent_business_id)
         AND (public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)))
  WITH CHECK (public.user_can_access_business(auth.uid(), parent_business_id)
         AND (public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)));

CREATE OR REPLACE FUNCTION public._consolidation_group_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.parent_business_id;
  IF v_org IS NULL OR v_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'Parent company must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = NEW.presentation_currency) THEN
    RAISE EXCEPTION 'Unknown presentation currency %', NEW.presentation_currency
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER consolidation_groups_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_groups
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_group_guard();