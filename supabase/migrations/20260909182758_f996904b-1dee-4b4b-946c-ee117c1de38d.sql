CREATE OR REPLACE FUNCTION public.enforce_batch_branch_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b record;
  d record;
BEGIN
  IF NEW.branch_id IS NULL OR NEW.collected_on IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT br.name, br.day_control_from INTO b
  FROM public.branches br WHERE br.id = NEW.branch_id;

  IF NOT FOUND OR b.day_control_from IS NULL OR NEW.collected_on < b.day_control_from THEN
    RETURN NEW;
  END IF;

  SELECT od.status INTO d
  FROM public.branch_operational_days od
  WHERE od.branch_id = NEW.branch_id
    AND od.business_date = NEW.collected_on;

  IF NOT FOUND THEN
    RAISE EXCEPTION '% has not been opened at %. Open the day before starting a collection round.',
      to_char(NEW.collected_on, 'DD Mon YYYY'), b.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF d.status <> 'open' THEN
    RAISE EXCEPTION '% is closed at %. A collection round cannot be dated a closed day.',
      to_char(NEW.collected_on, 'DD Mon YYYY'), b.name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_batch_branch_day() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_batch_branch_day ON public.mf_repayment_batches;
CREATE TRIGGER trg_enforce_batch_branch_day
BEFORE INSERT OR UPDATE OF collected_on, branch_id ON public.mf_repayment_batches
FOR EACH ROW EXECUTE FUNCTION public.enforce_batch_branch_day();