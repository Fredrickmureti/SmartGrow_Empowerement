CREATE OR REPLACE FUNCTION public._budgets_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
  _seq int;
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

  -- The reference a controller quotes. Derived, never chosen: a caller-supplied
  -- code would let two budgets in one company claim the same identity.
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(MAX(
             NULLIF(regexp_replace(b.budget_code, '^.*-', ''), '')::int
           ), 0) + 1
    INTO _seq
    FROM public.budgets b
    WHERE b.business_id = NEW.business_id
      AND b.fiscal_year = NEW.fiscal_year
      AND b.budget_code ~ '^BUD-[0-9]+-[0-9]+$';

    NEW.budget_code := 'BUD-' || NEW.fiscal_year::text || '-' || lpad(_seq::text, 3, '0');
  ELSE
    NEW.budget_code := OLD.budget_code;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;