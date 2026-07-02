
CREATE OR REPLACE FUNCTION public.seed_recurrence_next_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_recurring = true
     AND NEW.recurrence_parent_id IS NULL
     AND NEW.recurrence_next_at IS NULL THEN
    NEW.recurrence_next_at := COALESCE(NEW.start_date, NEW.deadline, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_recurrence_next_at ON public.project_tasks;
CREATE TRIGGER trg_seed_recurrence_next_at
BEFORE INSERT OR UPDATE OF is_recurring, recurrence_next_at, start_date, deadline
ON public.project_tasks
FOR EACH ROW
EXECUTE FUNCTION public.seed_recurrence_next_at();
