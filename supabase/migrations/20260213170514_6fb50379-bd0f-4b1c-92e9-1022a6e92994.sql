
CREATE OR REPLACE FUNCTION public.prevent_portal_group_assignment()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id
    AND organization_id = NEW.organization_id
    AND user_type = 'portal'
  ) THEN
    RAISE EXCEPTION 'Cannot assign access groups to portal users. Promote them to internal first.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_prevent_portal_group_assignment
BEFORE INSERT ON public.member_permission_groups
FOR EACH ROW EXECUTE FUNCTION public.prevent_portal_group_assignment();
