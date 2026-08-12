-- ============================================================
-- Canonical accounting rate book: provenance, precedence, publisher
-- ============================================================

ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_key text,
  ADD COLUMN IF NOT EXISTS published_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rates_source_check'
  ) THEN
    ALTER TABLE public.exchange_rates
      ADD CONSTRAINT exchange_rates_source_check
      CHECK (source IN ('provider', 'manual', 'override'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rates_rate_positive'
  ) THEN
    ALTER TABLE public.exchange_rates
      ADD CONSTRAINT exchange_rates_rate_positive CHECK (rate > 0);
  END IF;
END$$;

-- The old uniqueness ignored business scope and provenance.
ALTER TABLE public.exchange_rates
  DROP CONSTRAINT IF EXISTS exchange_rates_organization_id_from_currency_to_currency_ef_key;
DROP INDEX IF EXISTS public.exchange_rates_organization_id_from_currency_to_currency_ef_key;

CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_scope_unique
  ON public.exchange_rates (
    organization_id,
    COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    upper(from_currency),
    upper(to_currency),
    effective_date,
    source
  );

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
  ON public.exchange_rates (organization_id, upper(from_currency), upper(to_currency), effective_date DESC);

-- Normalise + validate codes on the accounting rate book itself.
CREATE OR REPLACE FUNCTION public._tg_exchange_rates_normalize()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.from_currency := public.normalize_currency_code(NEW.from_currency);
  NEW.to_currency   := public.normalize_currency_code(NEW.to_currency);
  IF NEW.from_currency = NEW.to_currency AND NEW.rate <> 1 THEN
    RAISE EXCEPTION 'Identity currency pair % must have rate 1', NEW.from_currency
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_exchange_rates_normalize ON public.exchange_rates;
CREATE TRIGGER tg_exchange_rates_normalize
  BEFORE INSERT OR UPDATE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public._tg_exchange_rates_normalize();

-- Provider-published history is immutable: reproducibility of posted rates.
CREATE OR REPLACE FUNCTION public._tg_exchange_rates_immutable_provider()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.source = 'provider' THEN
    RAISE EXCEPTION 'Provider-published exchange rates are immutable (id %). Record a tenant override instead.', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tg_exchange_rates_immutable_provider ON public.exchange_rates;
CREATE TRIGGER tg_exchange_rates_immutable_provider
  BEFORE UPDATE OR DELETE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public._tg_exchange_rates_immutable_provider();

-- ============================================================
-- ONE resolver, with deterministic precedence.
--   override > manual > provider ; business-scoped > org-wide ; latest effective_date
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_exchange_rate(
  p_org_id uuid, p_business_id uuid, p_currency text, p_on_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_rate numeric;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN 1;
  END IF;

  SELECT rate INTO v_rate
    FROM public.exchange_rates
   WHERE organization_id = p_org_id
     AND upper(from_currency) = upper(p_currency)
     AND upper(to_currency) = upper(v_base)
     AND effective_date <= COALESCE(p_on_date, CURRENT_DATE)
     AND (business_id IS NULL OR business_id = p_business_id)
   ORDER BY
     effective_date DESC,
     (business_id IS NOT NULL) DESC,
     CASE source WHEN 'override' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
     published_at DESC
   LIMIT 1;

  RETURN v_rate; -- NULL when nothing is on file; callers must never invent one.
END;
$$;

-- Provenance answer for "which exact rate was used, and where did it come from?"
CREATE OR REPLACE FUNCTION public.describe_exchange_rate(
  p_org_id uuid, p_business_id uuid, p_currency text, p_on_date date
)
RETURNS TABLE (rate numeric, source text, provider_key text, effective_date date, scope text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN QUERY SELECT 1::numeric, 'base'::text, NULL::text, COALESCE(p_on_date, CURRENT_DATE), 'identity'::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT er.rate, er.source, er.provider_key, er.effective_date,
         CASE WHEN er.business_id IS NULL THEN 'organization' ELSE 'business' END
    FROM public.exchange_rates er
   WHERE er.organization_id = p_org_id
     AND upper(er.from_currency) = upper(p_currency)
     AND upper(er.to_currency) = upper(v_base)
     AND er.effective_date <= COALESCE(p_on_date, CURRENT_DATE)
     AND (er.business_id IS NULL OR er.business_id = p_business_id)
   ORDER BY
     er.effective_date DESC,
     (er.business_id IS NOT NULL) DESC,
     CASE er.source WHEN 'override' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
     er.published_at DESC
   LIMIT 1;
END;
$$;

-- ============================================================
-- Bridge: platform market data -> accounting rate book
-- ============================================================
CREATE OR REPLACE FUNCTION public.publish_platform_rates(p_on_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_biz record;
  v_usd_to_base numeric;
  v_pair record;
BEGIN
  FOR v_biz IN
    SELECT b.id, b.organization_id, upper(b.base_currency) AS base_currency
      FROM public.businesses b
     WHERE b.base_currency IS NOT NULL
  LOOP
    SELECT per.rate INTO v_usd_to_base
      FROM public.platform_exchange_rates per
     WHERE per.is_active
       AND upper(per.from_currency) = 'USD'
       AND upper(per.to_currency) = v_biz.base_currency
     LIMIT 1;

    IF v_biz.base_currency = 'USD' THEN
      v_usd_to_base := 1;
    END IF;
    CONTINUE WHEN v_usd_to_base IS NULL OR v_usd_to_base <= 0;

    FOR v_pair IN
      SELECT upper(per.to_currency) AS code, per.rate, per.updated_at
        FROM public.platform_exchange_rates per
       WHERE per.is_active
         AND upper(per.from_currency) = 'USD'
         AND per.rate > 0
         AND upper(per.to_currency) <> v_biz.base_currency
    LOOP
      -- code -> base  =  (USD -> base) / (USD -> code)
      INSERT INTO public.exchange_rates (
        organization_id, business_id, from_currency, to_currency,
        rate, effective_date, source, provider_key, published_at
      )
      VALUES (
        v_biz.organization_id, v_biz.id, v_pair.code, v_biz.base_currency,
        ROUND(v_usd_to_base / v_pair.rate, 10), p_on_date, 'provider', 'platform', now()
      )
      ON CONFLICT DO NOTHING;

      v_inserted := v_inserted + 1;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_platform_rates(date) FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.exchange_rates TO authenticated;
GRANT ALL ON public.exchange_rates TO service_role;

-- Publish shortly after the half-hourly provider refresh.
SELECT cron.unschedule('publish-fx-rates')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'publish-fx-rates');

SELECT cron.schedule(
  'publish-fx-rates',
  '5,35 * * * *',
  $$ SELECT public.publish_platform_rates(); $$
);

-- Seed the accounting book from the rates already on the platform.
SELECT public.publish_platform_rates();