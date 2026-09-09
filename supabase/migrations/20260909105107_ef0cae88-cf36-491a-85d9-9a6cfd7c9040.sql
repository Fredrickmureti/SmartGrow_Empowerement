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

  IF v_count >= 1 THEN
    RAISE EXCEPTION 'This client already belongs to an active group. Exit that group first.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;