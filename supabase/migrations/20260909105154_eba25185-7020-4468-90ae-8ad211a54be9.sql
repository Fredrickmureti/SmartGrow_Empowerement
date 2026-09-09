CREATE OR REPLACE FUNCTION public._mf_group_member_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g RECORD;
  c RECORD;
BEGIN
  SELECT business_id, branch_id, status INTO g
    FROM public.mf_groups WHERE id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That group no longer exists.' USING ERRCODE = 'P0001';
  END IF;

  SELECT business_id, branch_id INTO c
    FROM public.mf_clients WHERE id = NEW.client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That client no longer exists.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.business_id IS DISTINCT FROM g.business_id THEN
    RAISE EXCEPTION 'This membership does not belong to the same institution as the group.'
      USING ERRCODE = 'P0001';
  END IF;

  IF c.business_id IS DISTINCT FROM g.business_id THEN
    RAISE EXCEPTION 'This client and this group belong to different institutions.'
      USING ERRCODE = 'P0001';
  END IF;

  IF c.branch_id IS DISTINCT FROM g.branch_id THEN
    RAISE EXCEPTION 'This group belongs to a different branch than the client.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.is_active AND g.status = 'closed' THEN
    RAISE EXCEPTION 'This group is closed and cannot take new members.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_group_members_consistency
BEFORE INSERT OR UPDATE OF group_id, client_id, business_id, is_active
ON public.mf_group_members
FOR EACH ROW EXECUTE FUNCTION public._mf_group_member_consistency();