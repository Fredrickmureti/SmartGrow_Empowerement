CREATE OR REPLACE FUNCTION public.enforce_je_balanced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF ABS(COALESCE(NEW.total_debit, 0) - COALESCE(NEW.total_credit, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry % not balanced: debit=%, credit=%',
      NEW.entry_number, NEW.total_debit, NEW.total_credit;
  END IF;
  RETURN NEW;
END;
$$;