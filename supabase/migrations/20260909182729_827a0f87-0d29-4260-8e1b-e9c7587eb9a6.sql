CREATE OR REPLACE FUNCTION public.enforce_branch_day_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reset_org TEXT;
  b         record;
  d         record;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND NEW.organization_id::text = reset_org THEN
    RETURN NEW;
  END IF;

  IF NEW.branch_id IS NULL OR NEW.entry_date IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT br.name, br.day_control_from INTO b
  FROM public.branches br WHERE br.id = NEW.branch_id;

  IF NOT FOUND OR b.day_control_from IS NULL OR NEW.entry_date < b.day_control_from THEN
    RETURN NEW;
  END IF;

  SELECT od.status INTO d
  FROM public.branch_operational_days od
  WHERE od.branch_id = NEW.branch_id
    AND od.business_date = NEW.entry_date;

  IF NOT FOUND THEN
    RAISE EXCEPTION '% has not been opened at %. Open the day before recording this transaction.',
      to_char(NEW.entry_date, 'DD Mon YYYY'), b.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF d.status <> 'open' THEN
    RAISE EXCEPTION '% is closed at %. This transaction needs an authorised reopening of that day.',
      to_char(NEW.entry_date, 'DD Mon YYYY'), b.name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_branch_day_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_branch_day_lock ON public.journal_entries;
CREATE TRIGGER trg_enforce_branch_day_lock
BEFORE INSERT OR UPDATE OF entry_date, status, branch_id ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_day_lock();