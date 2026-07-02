CREATE OR REPLACE FUNCTION public.trg_seed_journal_books_on_business()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_default_journal_books(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'seed_default_journal_books failed for business %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_journal_books_after_business_insert ON public.businesses;
CREATE TRIGGER seed_journal_books_after_business_insert
AFTER INSERT ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.trg_seed_journal_books_on_business();

DO $$
DECLARE
  b RECORD;
BEGIN
  FOR b IN
    SELECT bus.id FROM public.businesses bus
    WHERE NOT EXISTS (SELECT 1 FROM public.journal_books jb WHERE jb.business_id = bus.id)
  LOOP
    PERFORM public.seed_default_journal_books(b.id);
  END LOOP;
END;
$$;
