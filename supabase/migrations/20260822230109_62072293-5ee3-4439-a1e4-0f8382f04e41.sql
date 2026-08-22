CREATE OR REPLACE FUNCTION public._budgets_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
BEGIN
  SELECT base_currency INTO _base
  FROM public.businesses WHERE id = NEW.business_id;

  IF _base IS NULL THEN
    RAISE EXCEPTION 'Budget currency could not be resolved for business %', NEW.business_id;
  END IF;

  -- A budget is a plan expressed in the company's books. Actuals are read from
  -- journal_entry_lines.debit/credit, which are always base currency, so a
  -- budget in any other currency would compare two different units. The budget
  -- currency is therefore derived, never chosen.
  IF NEW.currency_code IS NOT NULL AND upper(NEW.currency_code) <> upper(_base) THEN
    RAISE EXCEPTION 'A budget is kept in the company base currency (%). % is not allowed.', _base, NEW.currency_code
      USING ERRCODE = '23514';
  END IF;

  NEW.currency_code := _base;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;