-- Function to mark bills as overdue when past due_date
CREATE OR REPLACE FUNCTION public.mark_overdue_bills()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on bills that are received or partial and past due
  IF NEW.status IN ('received', 'partial') AND NEW.due_date < CURRENT_DATE THEN
    NEW.status := 'overdue';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger on insert/update to auto-detect overdue
CREATE TRIGGER trg_bill_overdue_check
  BEFORE INSERT OR UPDATE ON public.bills
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_overdue_bills();

-- Also update all currently overdue bills in one shot
UPDATE public.bills
SET status = 'overdue'
WHERE status IN ('received', 'partial')
  AND due_date < CURRENT_DATE;