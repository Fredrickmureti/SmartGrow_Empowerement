-- 1. Currency is a canonical ISO code from public.currencies; no schema-level literal default.
ALTER TABLE public.landed_cost_vouchers ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.landed_cost_vouchers ALTER COLUMN exchange_rate DROP DEFAULT;

-- 2. Server-authoritative FX stamping. The browser never supplies the booking rate.
CREATE OR REPLACE FUNCTION public._landed_cost_voucher_fx_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_stamp record;
  v_date date;
BEGIN
  -- Posted / reversed vouchers are immutable in their monetary contract.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed') THEN
    IF NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
       OR NEW.exchange_rate_date IS DISTINCT FROM OLD.exchange_rate_date THEN
      RAISE EXCEPTION
        'the currency and exchange rate of a % landed cost voucher cannot be changed', OLD.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Only re-stamp when the monetary inputs actually move.
  IF TG_OP = 'UPDATE'
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency
     AND NEW.voucher_date IS NOT DISTINCT FROM OLD.voucher_date
     AND NEW.exchange_rate_date IS NOT DISTINCT FROM OLD.exchange_rate_date THEN
    NEW.exchange_rate := OLD.exchange_rate;
    RETURN NEW;
  END IF;

  v_code := public.normalize_currency_code(NEW.currency);

  IF v_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.currencies c WHERE c.code = v_code AND c.is_active IS TRUE
  ) THEN
    RAISE EXCEPTION '% is not an active currency in the currency catalogue', NEW.currency
      USING ERRCODE = '23514';
  END IF;

  v_date := COALESCE(NEW.exchange_rate_date, NEW.voucher_date, CURRENT_DATE);

  -- fx_stamp_document: canonical code (falls back to the business base currency)
  -- + require_exchange_rate, which RAISES when no rate is on file. No 1:1 fallback.
  v_stamp := public.fx_stamp_document(
    NEW.organization_id, NEW.business_id, v_code, v_date);

  NEW.currency := v_stamp.currency;
  NEW.exchange_rate := v_stamp.rate;
  NEW.exchange_rate_date := v_date;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lc_vouchers_fx_stamp ON public.landed_cost_vouchers;
CREATE TRIGGER trg_lc_vouchers_fx_stamp
  BEFORE INSERT OR UPDATE ON public.landed_cost_vouchers
  FOR EACH ROW EXECUTE FUNCTION public._landed_cost_voucher_fx_stamp();

-- 3. Re-value draft components when the stamped rate moves.
CREATE OR REPLACE FUNCTION public._landed_cost_voucher_revalue_components()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.exchange_rate IS NOT DISTINCT FROM OLD.exchange_rate THEN
    RETURN NEW;
  END IF;

  UPDATE public.landed_cost_components
     SET base_amount = ROUND(amount * NEW.exchange_rate, 2)
   WHERE voucher_id = NEW.id;

  UPDATE public.landed_cost_vouchers v
     SET total_amount = COALESCE(t.amount, 0),
         total_base_amount = COALESCE(t.base_amount, 0)
    FROM (
      SELECT COALESCE(SUM(amount), 0) AS amount,
             COALESCE(SUM(base_amount), 0) AS base_amount
        FROM public.landed_cost_components WHERE voucher_id = NEW.id
    ) t
   WHERE v.id = NEW.id;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lc_vouchers_revalue ON public.landed_cost_vouchers;
CREATE TRIGGER trg_lc_vouchers_revalue
  AFTER UPDATE ON public.landed_cost_vouchers
  FOR EACH ROW EXECUTE FUNCTION public._landed_cost_voucher_revalue_components();

-- 4. Remove the silent 1:1 fallbacks from the accounting path.
CREATE OR REPLACE FUNCTION public._landed_cost_component_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_voucher RECORD;
  v_id uuid := COALESCE(NEW.voucher_id, OLD.voucher_id);
BEGIN
  SELECT * INTO v_voucher FROM public.landed_cost_vouchers WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF v_voucher.exchange_rate IS NULL OR v_voucher.exchange_rate <= 0 THEN
      RAISE EXCEPTION
        'voucher % has no exchange rate on file for % — a landed cost cannot be valued at parity',
        v_id, v_voucher.currency
        USING ERRCODE = 'P0001';
    END IF;
    NEW.organization_id := v_voucher.organization_id;
    NEW.business_id := v_voucher.business_id;
    NEW.base_amount := ROUND(NEW.amount * v_voucher.exchange_rate, 2);
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$function$;
