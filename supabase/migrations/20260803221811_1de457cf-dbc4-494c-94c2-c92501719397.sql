-- ═══════════════════════════════════════════════════════════════════
-- 3PL billing — Phase 4: pricing correctness
-- ═══════════════════════════════════════════════════════════════════

-- ── 1) Contract-shaped tariffs ──────────────────────────────────────
ALTER TABLE public.wms_billing_tariffs
  ADD COLUMN IF NOT EXISTS min_charge        numeric NULL,
  ADD COLUMN IF NOT EXISTS included_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier_from         numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier_to           numeric NULL;

ALTER TABLE public.wms_billing_tariffs
  DROP CONSTRAINT IF EXISTS wms_billing_tariffs_tier_sane;
ALTER TABLE public.wms_billing_tariffs
  ADD CONSTRAINT wms_billing_tariffs_tier_sane
  CHECK (tier_from >= 0
         AND (tier_to IS NULL OR tier_to > tier_from)
         AND included_quantity >= 0
         AND (min_charge IS NULL OR min_charge >= 0));

CREATE INDEX IF NOT EXISTS idx_wms_billing_tariffs_resolve
  ON public.wms_billing_tariffs (business_id, activity, is_active, effective_from DESC);

COMMENT ON COLUMN public.wms_billing_tariffs.min_charge IS
  'Floor applied to the computed line amount for a single activity occurrence.';
COMMENT ON COLUMN public.wms_billing_tariffs.included_quantity IS
  'Quantity priced at zero before the rate applies (contract allowance).';
COMMENT ON COLUMN public.wms_billing_tariffs.tier_from IS
  'Inclusive lower bound of the quantity band this rate prices.';
COMMENT ON COLUMN public.wms_billing_tariffs.tier_to IS
  'Exclusive upper bound of the quantity band; NULL = open ended.';

-- ── 2) Currency discipline: only enabled business currencies ────────
CREATE OR REPLACE FUNCTION public._wms_tariff_currency_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_base text;
BEGIN
  IF NEW.currency IS NULL THEN
    RAISE EXCEPTION 'tariff currency is required';
  END IF;
  NEW.currency := upper(btrim(NEW.currency));

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  IF NEW.currency = upper(COALESCE(v_base, '')) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.business_active_currencies
     WHERE business_id = NEW.business_id
       AND upper(currency_code) = NEW.currency
       AND is_enabled
  ) THEN
    RAISE EXCEPTION
      'currency % is not enabled for this business; enable it in Finance settings first',
      NEW.currency;
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS tg_wms_tariff_currency_guard ON public.wms_billing_tariffs;
CREATE TRIGGER tg_wms_tariff_currency_guard
  BEFORE INSERT OR UPDATE OF currency ON public.wms_billing_tariffs
  FOR EACH ROW EXECUTE FUNCTION public._wms_tariff_currency_guard();

-- ── 3) Unpriced activity is an operational exception ────────────────
ALTER TYPE public.wms_exception_kind ADD VALUE IF NOT EXISTS 'billing_unpriced';

-- ── 4) FX rate stamped on the invoice ───────────────────────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS exchange_rate numeric NULL;
COMMENT ON COLUMN public.invoices.exchange_rate IS
  'Rate used to translate this invoice currency into the business base currency at issue date.';
