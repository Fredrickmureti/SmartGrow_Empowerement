CREATE OR REPLACE FUNCTION public._mf_group_members_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.client_id::text, 0));

  SELECT count(*) INTO v_count
    FROM public.mf_group_members m
   WHERE m.client_id = NEW.client_id
     AND m.is_active
     AND m.id <> NEW.id;

  IF v_count >= 2 THEN
    RAISE EXCEPTION 'This client already belongs to two active groups. Exit one before adding another.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mf_group_members_limit ON public.mf_group_members;
CREATE TRIGGER mf_group_members_limit
  BEFORE INSERT OR UPDATE OF client_id, is_active ON public.mf_group_members
  FOR EACH ROW EXECUTE FUNCTION public._mf_group_members_limit();