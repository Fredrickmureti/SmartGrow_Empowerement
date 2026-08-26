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
  IF TG_OP = 'UPDATE' THEN
    -- Identity of a membership row is immutable: repointing it at another company or
    -- group would silently rewrite ownership history.
    IF NEW.business_id <> OLD.business_id THEN
      RAISE EXCEPTION 'Company of an existing membership cannot be changed; close it out and add a new one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.group_id <> OLD.group_id THEN
      RAISE EXCEPTION 'Group of an existing membership cannot be changed' USING ERRCODE = '23514';
    END IF;
    NEW.organization_id := OLD.organization_id;
    NEW.created_by := OLD.created_by;
  ELSE
    NEW.created_by := auth.uid();
  END IF;

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

  -- No two membership periods for the same company in the same group may overlap.
  IF EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = NEW.group_id
       AND m.business_id = NEW.business_id
       AND m.id IS DISTINCT FROM NEW.id
       AND daterange(m.effective_from, m.effective_to, '[)')
           && daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'Company already has a membership covering that period in this group'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_business_id IS NOT NULL THEN
    IF NEW.business_id = v_group.parent_business_id THEN
      RAISE EXCEPTION 'The parent company of the group cannot itself have a parent inside the group'
        USING ERRCODE = '23514';
    END IF;

    SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.parent_business_id;
    IF v_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'Parent company must belong to the same organization as the group' USING ERRCODE = '23514';
    END IF;

    -- The declared parent must be in scope for the same period, otherwise the chain
    -- points outside the consolidation.
    IF NEW.parent_business_id <> v_group.parent_business_id
       AND NOT EXISTS (
         SELECT 1 FROM public.consolidation_group_members m
          WHERE m.group_id = NEW.group_id
            AND m.business_id = NEW.parent_business_id
            AND m.id IS DISTINCT FROM NEW.id
            AND daterange(m.effective_from, m.effective_to, '[)')
                && daterange(NEW.effective_from, NEW.effective_to, '[)')
       ) THEN
      RAISE EXCEPTION 'Parent company must itself be a member of the group for the same period'
        USING ERRCODE = '23514';
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