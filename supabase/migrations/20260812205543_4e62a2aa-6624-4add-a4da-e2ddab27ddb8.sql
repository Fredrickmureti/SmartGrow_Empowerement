-- ============================================================
-- Phase 2 — party default currency integrity
-- ============================================================
CREATE OR REPLACE FUNCTION public.normalize_currency_code(p_code text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE v text;
BEGIN
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RETURN NULL;
  END IF;
  v := upper(btrim(p_code));
  IF NOT EXISTS (SELECT 1 FROM public.currencies c WHERE c.code = v AND COALESCE(c.is_active, true)) THEN
    RAISE EXCEPTION 'Unknown or inactive currency code: %', p_code
      USING ERRCODE = '23514';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public._tg_normalize_party_default_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.default_currency := public.normalize_currency_code(NEW.default_currency);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_suppliers_default_currency ON public.suppliers;
CREATE TRIGGER trg_suppliers_default_currency
  BEFORE INSERT OR UPDATE OF default_currency ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public._tg_normalize_party_default_currency();

DROP TRIGGER IF EXISTS trg_contacts_default_currency ON public.contacts;
CREATE TRIGGER trg_contacts_default_currency
  BEFORE INSERT OR UPDATE OF default_currency ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public._tg_normalize_party_default_currency();

-- ============================================================
-- Phase 3 — one exchange-rate resolver for AR and AP
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_exchange_rate(
  p_org_id uuid,
  p_business_id uuid,
  p_currency text,
  p_on_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
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
   ORDER BY effective_date DESC, business_id NULLS LAST
   LIMIT 1;

  RETURN v_rate; -- NULL when the org has no rate on file; caller must not invent one.
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_exchange_rate(uuid, uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_exchange_rate(uuid, uuid, text, date) TO authenticated, service_role;

-- AR keeps its historical entry point, now a thin shim over the single resolver.
CREATE OR REPLACE FUNCTION public.resolve_sales_exchange_rate(
  p_org_id uuid,
  p_business_id uuid,
  p_currency text,
  p_on_date date
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.resolve_exchange_rate(p_org_id, p_business_id, p_currency, p_on_date);
$$;

-- ============================================================
-- Phase 4 — purchasing headers derive currency from base currency
-- ============================================================
ALTER TABLE public.bills               ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.purchase_orders     ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.vendor_credit_notes ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.purchase_returns    ALTER COLUMN currency DROP DEFAULT;

-- Resolves the rate a purchasing document must be stamped with, refusing to
-- invent 1 when the org has no rate on file for a foreign currency.
CREATE OR REPLACE FUNCTION public.require_exchange_rate(
  p_org_id uuid,
  p_business_id uuid,
  p_currency text,
  p_on_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base text;
  v_rate numeric;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = p_business_id;
  IF p_currency IS NULL OR v_base IS NULL OR upper(p_currency) = upper(v_base) THEN
    RETURN 1;
  END IF;

  v_rate := public.resolve_exchange_rate(p_org_id, p_business_id, p_currency, p_on_date);
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'No exchange rate on file for % -> % on %', upper(p_currency), upper(v_base),
      COALESCE(p_on_date, CURRENT_DATE)
      USING ERRCODE = '23514';
  END IF;
  RETURN v_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.require_exchange_rate(uuid, uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.require_exchange_rate(uuid, uuid, text, date) TO authenticated, service_role;

-- Bills -------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_bill_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_base text;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), v_base);

  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.currency_rate IS DISTINCT FROM OLD.currency_rate)
     AND EXISTS (SELECT 1 FROM public.journal_entries je
                  WHERE je.source_type = 'bill' AND je.source_id = OLD.id
                    AND je.status = 'posted') THEN
    RAISE EXCEPTION 'Currency and rate of a posted bill are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    NEW.currency_rate := public.require_exchange_rate(
      NEW.organization_id, NEW.business_id, NEW.currency, NEW.bill_date);
  END IF;

  NEW.currency_rate := COALESCE(NULLIF(NEW.currency_rate, 0), 1);
  NEW.company_currency_total := ROUND(COALESCE(NEW.total, 0) * NEW.currency_rate, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_stamp_currency ON public.bills;
CREATE TRIGGER trg_bills_stamp_currency
  BEFORE INSERT OR UPDATE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_bill_currency();

-- Purchase orders (commitment only: currency, no GL rate) -----
CREATE OR REPLACE FUNCTION public._tg_stamp_po_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_base text;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), v_base);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_stamp_currency ON public.purchase_orders;
CREATE TRIGGER trg_po_stamp_currency
  BEFORE INSERT OR UPDATE OF currency ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_po_currency();

-- Vendor credit notes -----------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_vcn_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_base text;
  v_date date;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), v_base);
  v_date := COALESCE(NEW.exchange_rate_date, NEW.credit_note_date, CURRENT_DATE);

  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND EXISTS (SELECT 1 FROM public.journal_entries je
                  WHERE je.source_type = 'vendor_credit_note' AND je.source_id = OLD.id
                    AND je.status = 'posted') THEN
    RAISE EXCEPTION 'Currency and rate of a posted vendor credit note are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.exchange_rate IS NULL THEN
    NEW.exchange_rate := public.require_exchange_rate(
      NEW.organization_id, NEW.business_id, NEW.currency, v_date);
    NEW.exchange_rate_date := v_date;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vcn_stamp_currency ON public.vendor_credit_notes;
CREATE TRIGGER trg_vcn_stamp_currency
  BEFORE INSERT OR UPDATE ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_vcn_currency();

-- Purchase returns --------------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_purchase_return_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_base text;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), v_base);

  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    NEW.exchange_rate := public.require_exchange_rate(
      NEW.organization_id, NEW.business_id, NEW.currency, NEW.return_date);
  END IF;
  NEW.exchange_rate := COALESCE(NULLIF(NEW.exchange_rate, 0), 1);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_returns_stamp_currency ON public.purchase_returns;
CREATE TRIGGER trg_purchase_returns_stamp_currency
  BEFORE INSERT OR UPDATE ON public.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_purchase_return_currency();

COMMENT ON COLUMN public.suppliers.default_currency IS
  'ADR 0135: proposal-time default only. ISO code validated against public.currencies. Snapshotted onto documents at creation; never re-read afterwards.';