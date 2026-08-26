REVOKE ALL ON FUNCTION public._consolidation_group_guard() FROM PUBLIC, anon, authenticated;

CREATE TYPE public.consolidation_method AS ENUM ('full', 'proportional', 'equity', 'excluded');

CREATE TABLE public.consolidation_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  parent_business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT,
  ownership_percent numeric(9,6) NOT NULL DEFAULT 100,
  method public.consolidation_method NOT NULL DEFAULT 'full',
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_member_ownership_range CHECK (ownership_percent > 0 AND ownership_percent <= 100),
  CONSTRAINT consolidation_member_period CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT consolidation_member_not_self_parent CHECK (parent_business_id IS NULL OR parent_business_id <> business_id)
);

CREATE UNIQUE INDEX consolidation_group_members_open_key
  ON public.consolidation_group_members (group_id, business_id)
  WHERE effective_to IS NULL;
CREATE INDEX consolidation_group_members_group_idx
  ON public.consolidation_group_members (group_id);
CREATE INDEX consolidation_group_members_business_idx
  ON public.consolidation_group_members (business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_group_members TO authenticated;
GRANT ALL ON public.consolidation_group_members TO service_role;

ALTER TABLE public.consolidation_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_group_members_select ON public.consolidation_group_members
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id)
         AND public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY consolidation_group_members_write ON public.consolidation_group_members
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
         AND (public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)));

CREATE OR REPLACE FUNCTION public._consolidation_member_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group record;
  v_org uuid;
  v_cursor uuid;
  v_depth int := 0;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups WHERE id = NEW.group_id;
  IF v_group.id IS NULL THEN
    RAISE EXCEPTION 'Consolidation group not found' USING ERRCODE = '23503';
  END IF;

  IF v_group.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Member organization must match the group organization' USING ERRCODE = '23514';
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.business_id;
  IF v_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'Company must belong to the same organization as the group' USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_business_id IS NOT NULL THEN
    SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.parent_business_id;
    IF v_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'Parent company must belong to the same organization as the group' USING ERRCODE = '23514';
    END IF;

    -- walk the ownership chain upwards; a cycle would make consolidation non-terminating
    v_cursor := NEW.parent_business_id;
    WHILE v_cursor IS NOT NULL AND v_depth < 50 LOOP
      IF v_cursor = NEW.business_id THEN
        RAISE EXCEPTION 'Ownership chain would create a cycle' USING ERRCODE = '23514';
      END IF;
      SELECT parent_business_id INTO v_cursor
        FROM public.consolidation_group_members
       WHERE group_id = NEW.group_id
         AND business_id = v_cursor
         AND effective_to IS NULL
         AND id IS DISTINCT FROM NEW.id
       LIMIT 1;
      v_depth := v_depth + 1;
    END LOOP;
    IF v_depth >= 50 THEN
      RAISE EXCEPTION 'Ownership chain is too deep' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.method = 'full' AND NEW.ownership_percent < 50 THEN
    RAISE EXCEPTION 'Full consolidation requires a controlling interest of at least 50%%'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_member_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER consolidation_group_members_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_group_members
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_member_guard();