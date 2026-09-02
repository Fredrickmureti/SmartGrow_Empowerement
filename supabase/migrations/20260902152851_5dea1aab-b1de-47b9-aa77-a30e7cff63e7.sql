CREATE OR REPLACE FUNCTION public._recompute_je_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  je_ids uuid[];
  je_id  uuid;
BEGIN
  -- The canonical posting engine writes the header with final totals and then
  -- inserts its lines; it sets this flag for the duration. Recomputing here
  -- would attempt to UPDATE an already-posted header and be rejected by the
  -- immutability trigger.
  IF COALESCE(current_setting('app.suppress_je_recompute', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    je_ids := ARRAY[NEW.journal_entry_id];
  ELSIF TG_OP = 'DELETE' THEN
    je_ids := ARRAY[OLD.journal_entry_id];
  ELSE
    je_ids := ARRAY[NEW.journal_entry_id];
    IF OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
      je_ids := je_ids || OLD.journal_entry_id;
    END IF;
  END IF;

  FOREACH je_id IN ARRAY je_ids LOOP
    UPDATE public.journal_entries je
       SET total_debit  = COALESCE((SELECT SUM(debit)  FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0),
           total_credit = COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0)
     WHERE je.id = je_id
       AND (je.total_debit IS DISTINCT FROM COALESCE((SELECT SUM(debit)  FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0)
            OR je.total_credit IS DISTINCT FROM COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0));
  END LOOP;

  RETURN NULL;
END;
$function$;