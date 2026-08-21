-- Step 6: make the per-company operating-currency gate real and self-consistent.

-- 1. Every company always carries an enabled row for its own base currency.
CREATE OR REPLACE FUNCTION public._seed_business_base_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_code text;
BEGIN
  v_code := upper(NULLIF(btrim(NEW.base_currency), ''));
  IF v_code IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.business_active_currencies
    (organization_id, business_id, currency_code, is_enabled, created_by)
  VALUES (NEW.organization_id, NEW.id, v_code, true, auth.uid())
  ON CONFLICT (business_id, currency_code) DO UPDATE SET is_enabled = true;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_business_base_currency ON public.businesses;
CREATE TRIGGER trg_seed_business_base_currency
  AFTER INSERT OR UPDATE OF base_currency ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public._seed_business_base_currency();

-- 2. The base-currency row can never be disabled, re-pointed or deleted,
--    whatever path the write arrives on (RPC, Data API or admin SQL).
CREATE OR REPLACE FUNCTION public._bac_protect_base_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_base text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT upper(base_currency) INTO v_base FROM public.businesses WHERE id = OLD.business_id;
    IF v_base IS NOT NULL AND OLD.currency_code = v_base THEN
      RAISE EXCEPTION 'The base currency of a company cannot be removed from its operating currencies'
        USING ERRCODE = '22023';
    END IF;
    RETURN OLD;
  END IF;

  NEW.currency_code := upper(NULLIF(btrim(NEW.currency_code), ''));
  IF NEW.currency_code IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = NEW.currency_code AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive currency code' USING ERRCODE = '22023';
  END IF;

  SELECT upper(base_currency) INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  IF v_base IS NOT NULL AND NEW.currency_code = v_base AND NOT NEW.is_enabled THEN
    RAISE EXCEPTION 'The base currency of a company cannot be disabled' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bac_protect_base_currency ON public.business_active_currencies;
CREATE TRIGGER trg_bac_protect_base_currency
  BEFORE INSERT OR UPDATE OR DELETE ON public.business_active_currencies
  FOR EACH ROW EXECUTE FUNCTION public._bac_protect_base_currency();

-- 3. Expenses now honour the gate unconditionally, like bank accounts and
--    procurement contracts already do. The "no rows means anything goes"
--    escape hatch is gone: the seed guarantees the base row always exists.
CREATE OR REPLACE FUNCTION public._expenses_derive_base_amount()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_base text;
  v_rate numeric;
  v_tax_rate numeric;
BEGIN
  SELECT b.base_currency INTO v_base FROM public.businesses b WHERE b.id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), upper(v_base));

  IF NEW.currency <> upper(v_base)
     AND NOT EXISTS (
       SELECT 1 FROM public.business_active_currencies bac
        WHERE bac.business_id = NEW.business_id
          AND bac.is_enabled
          AND bac.currency_code = NEW.currency) THEN
    RAISE EXCEPTION 'Currency % is not enabled for this company. Enable it in Settings > Currency first.', NEW.currency
      USING ERRCODE = '22023';
  END IF;

  v_rate := public.require_exchange_rate(
    NEW.organization_id, NEW.business_id, NEW.currency, NEW.expense_date);

  NEW.exchange_rate := v_rate;
  NEW.base_amount := ROUND(COALESCE(NEW.amount, 0) * v_rate, 2);

  IF NEW.tax_rate_id IS NULL THEN
    NEW.tax_amount := 0;
  ELSE
    SELECT tr.rate INTO v_tax_rate
      FROM public.tax_rates tr
     WHERE tr.id = NEW.tax_rate_id AND tr.organization_id = NEW.organization_id;
    IF v_tax_rate IS NULL THEN
      RAISE EXCEPTION 'Tax rate not found for this organization' USING ERRCODE = '22023';
    END IF;
    NEW.tax_amount := ROUND(COALESCE(NEW.amount, 0) * v_tax_rate / (100 + v_tax_rate), 2);
  END IF;

  NEW.tax_treatment := COALESCE(NEW.tax_treatment, 'recoverable');
  RETURN NEW;
END; $$;

-- 4. Read model for the settings screen: the enabled set plus whether each row
--    is the (undeletable) base currency, resolved server-side.
CREATE OR REPLACE FUNCTION public.list_business_active_currencies(_business_id uuid)
RETURNS TABLE (currency_code text, is_enabled boolean, is_base boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT bac.currency_code,
         bac.is_enabled,
         bac.currency_code = upper(b.base_currency) AS is_base
    FROM public.business_active_currencies bac
    JOIN public.businesses b ON b.id = bac.business_id
   WHERE bac.business_id = _business_id
     AND public.user_can_access_business(auth.uid(), _business_id)
   ORDER BY (bac.currency_code = upper(b.base_currency)) DESC, bac.currency_code;
$$;

REVOKE ALL ON FUNCTION public.list_business_active_currencies(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_business_active_currencies(uuid) TO authenticated;