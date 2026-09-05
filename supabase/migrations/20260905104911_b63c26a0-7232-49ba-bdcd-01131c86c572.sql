CREATE OR REPLACE FUNCTION public.enforce_contact_on_posting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_missing int;
BEGIN
  IF NEW.status::text = 'posted' AND COALESCE(OLD.status::text, '') <> 'posted' THEN
    SELECT count(*) INTO v_missing
    FROM public.journal_entry_lines jel
    JOIN public.accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.id
      AND a.system_role IN ('accounts_receivable', 'accounts_payable')
      AND jel.contact_id IS NULL;

    IF v_missing > 0 THEN
      RAISE EXCEPTION
        'AR/AP integrity: cannot post entry % — % control-account line(s) missing contact_id',
        NEW.id, v_missing
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;