CREATE OR REPLACE FUNCTION public.sync_fiscal_period_closed_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.is_closed := (NEW.status = 'closed');
  IF NEW.is_closed AND NEW.closed_at IS NULL THEN
    NEW.closed_at := now();
  ELSIF NOT NEW.is_closed THEN
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_fiscal_period_closed_flag() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_fiscal_period_closed_flag ON public.fiscal_periods;
CREATE TRIGGER trg_sync_fiscal_period_closed_flag
BEFORE INSERT OR UPDATE OF status ON public.fiscal_periods
FOR EACH ROW EXECUTE FUNCTION public.sync_fiscal_period_closed_flag();

UPDATE public.fiscal_periods
   SET is_closed = (status = 'closed')
 WHERE is_closed IS DISTINCT FROM (status = 'closed');