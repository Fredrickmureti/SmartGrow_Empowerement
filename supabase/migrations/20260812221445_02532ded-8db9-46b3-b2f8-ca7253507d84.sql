-- ============================================================
-- Step 5-7: snapshot columns, one shared stamper, no literal defaults
-- ============================================================

ALTER TABLE public.estimates        ADD COLUMN IF NOT EXISTS exchange_rate numeric;
ALTER TABLE public.credit_notes     ADD COLUMN IF NOT EXISTS exchange_rate numeric;
ALTER TABLE public.customer_refunds ADD COLUMN IF NOT EXISTS exchange_rate numeric;
ALTER TABLE public.purchase_orders  ADD COLUMN IF NOT EXISTS exchange_rate numeric;

-- Literal denominations are not a business fact.
ALTER TABLE public.invoices          ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.estimates         ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.credit_notes      ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.customer_refunds  ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.sales_orders      ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.proforma_invoices ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.expenses          ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.expenses          ALTER COLUMN exchange_rate DROP DEFAULT;

-- ------------------------------------------------------------
-- ONE stamper. Every document trigger delegates here.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fx_stamp_document(
  p_org uuid, p_biz uuid, p_currency text, p_date date,
  OUT currency text, OUT rate numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
BEGIN
  SELECT b.base_currency INTO v_base FROM public.businesses b WHERE b.id = p_biz;
  currency := COALESCE(public.normalize_currency_code(p_currency), upper(v_base));
  IF currency IS NULL THEN
    RAISE EXCEPTION 'Cannot determine document currency: business has no base currency'
      USING ERRCODE = '23514';
  END IF;
  rate := public.require_exchange_rate(p_org, p_biz, currency, COALESCE(p_date, CURRENT_DATE));
END;
$$;

CREATE OR REPLACE FUNCTION public._fx_document_is_posted(p_source_type text, p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.journal_entries je
     WHERE je.source_type = p_source_type AND je.source_id = p_id AND je.status = 'posted'
  );
$$;

-- ------------------------------------------------------------
-- Per-document triggers (thin: date column + posted source_type differ)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_invoice_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted('invoice', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted invoice are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.exchange_rate IS NULL THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.issue_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_invoices_stamp_currency ON public.invoices;
CREATE TRIGGER trg_invoices_stamp_currency
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_invoice_currency();

CREATE OR REPLACE FUNCTION public._tg_stamp_estimate_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS NULL THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.issue_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_estimates_stamp_currency ON public.estimates;
CREATE TRIGGER trg_estimates_stamp_currency
  BEFORE INSERT OR UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_estimate_currency();

CREATE OR REPLACE FUNCTION public._tg_stamp_sales_order_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS NULL THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.order_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sales_orders_stamp_currency ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_stamp_currency
  BEFORE INSERT OR UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_sales_order_currency();

CREATE OR REPLACE FUNCTION public._tg_stamp_credit_note_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted('credit_note', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted credit note are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS NULL THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.issue_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_credit_notes_stamp_currency ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_stamp_currency
  BEFORE INSERT OR UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_credit_note_currency();

CREATE OR REPLACE FUNCTION public._tg_stamp_customer_refund_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS NULL THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.refund_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_customer_refunds_stamp_currency ON public.customer_refunds;
CREATE TRIGGER trg_customer_refunds_stamp_currency
  BEFORE INSERT OR UPDATE ON public.customer_refunds
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_customer_refund_currency();

-- Purchase orders already stamp currency; give them the rate snapshot too.
CREATE OR REPLACE FUNCTION public._tg_stamp_po_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS NULL THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.order_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

-- ------------------------------------------------------------
-- Expenses: delegate to the canonical resolver, no COALESCE(rate, 1)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._expenses_derive_base_amount()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_base text;
  v_rate numeric;
  v_tax_rate numeric;
  v_active_count int;
BEGIN
  SELECT b.base_currency INTO v_base FROM public.businesses b WHERE b.id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), upper(v_base));

  SELECT count(*) INTO v_active_count
    FROM public.business_active_currencies bac
   WHERE bac.business_id = NEW.business_id AND bac.is_enabled;

  IF v_active_count > 0 AND NEW.currency <> upper(v_base)
     AND NOT EXISTS (
       SELECT 1 FROM public.business_active_currencies bac
        WHERE bac.business_id = NEW.business_id
          AND bac.is_enabled
          AND bac.currency_code = NEW.currency) THEN
    RAISE EXCEPTION 'Currency % is not enabled for this business', NEW.currency
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