
DROP FUNCTION IF EXISTS public.get_next_journal_entry_number(uuid);

CREATE OR REPLACE FUNCTION public.get_next_journal_entry_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('journal_entries_' || _org_id::text));
  
  SELECT COALESCE(MAX(
    CASE WHEN entry_number ~ '\d+$'
      THEN CAST(substring(entry_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.journal_entries
  WHERE organization_id = _org_id;
  
  RETURN 'JE-' || LPAD(next_num::text, 5, '0');
END;
$$;
