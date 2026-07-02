
-- Reject AR/AP control-account lines that are missing a contact.
CREATE OR REPLACE FUNCTION public.enforce_contact_on_control_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT a.system_role INTO v_role
  FROM public.accounts a
  WHERE a.id = NEW.account_id;

  IF v_role IN ('accounts_receivable', 'accounts_payable')
     AND NEW.contact_id IS NULL THEN
    RAISE EXCEPTION
      'AR/AP integrity: journal line on % control account requires contact_id (account=%)',
      v_role, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_contact_on_control_line ON public.journal_entry_lines;
CREATE TRIGGER trg_enforce_contact_on_control_line
BEFORE INSERT OR UPDATE OF account_id, contact_id
ON public.journal_entry_lines
FOR EACH ROW
EXECUTE FUNCTION public.enforce_contact_on_control_line();

-- On posting, re-verify every AR/AP line on the entry carries a contact.
CREATE OR REPLACE FUNCTION public.enforce_contact_on_posting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_missing int;
BEGIN
  IF NEW.status = 'posted' AND COALESCE(OLD.status,'') <> 'posted' THEN
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
$$;

DROP TRIGGER IF EXISTS trg_enforce_contact_on_posting ON public.journal_entries;
CREATE TRIGGER trg_enforce_contact_on_posting
BEFORE UPDATE OF status ON public.journal_entries
FOR EACH ROW
EXECUTE FUNCTION public.enforce_contact_on_posting();
