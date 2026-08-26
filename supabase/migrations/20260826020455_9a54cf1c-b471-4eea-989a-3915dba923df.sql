-- ============================================================
-- Phase 3 — Close the stamping gaps (D2, D3, D9, D10, D11)
-- ============================================================

-- Shared helper: posted check across alternative source_type spellings
CREATE OR REPLACE FUNCTION public._fx_document_is_posted_any(p_source_types text[], p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.journal_entries je
     WHERE je.source_type = ANY (p_source_types)
       AND je.source_id = p_id
       AND je.status = 'posted'
  );
$$;

-- ------------------------------------------------------------
-- 3a. bill_payments (D3)
-- ------------------------------------------------------------
ALTER TABLE public.bill_payments ADD COLUMN IF NOT EXISTS currency text;

UPDATE public.bill_payments bp
   SET currency = upper(COALESCE(
         (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id = bp.bank_account_id),
         (SELECT biz.base_currency FROM public.businesses biz WHERE biz.id = bp.business_id)))
 WHERE bp.currency IS NULL;

CREATE OR REPLACE FUNCTION public._tg_stamp_bill_payment_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s record;
  v_locked boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.currency_rate IS DISTINCT FROM OLD.currency_rate) THEN
    v_locked := public._fx_document_is_posted_any(
                  ARRAY['bill_payment','bill_payments','payment'], OLD.id)
             OR EXISTS (SELECT 1 FROM public.bill_payment_allocations a
                         WHERE a.bill_payment_id = OLD.id);
    IF v_locked THEN
      RAISE EXCEPTION 'Currency and rate of a posted or allocated bill payment are immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
     OR NEW.currency_rate IS NULL
     OR NEW.currency_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id,
      NEW.business_id,
      COALESCE(NEW.currency,
               (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id = NEW.bank_account_id)),
      NEW.payment_date);
    NEW.currency := s.currency;
    NEW.currency_rate := s.rate;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bill_payments_stamp_currency ON public.bill_payments;
CREATE TRIGGER trg_bill_payments_stamp_currency
  BEFORE INSERT OR UPDATE ON public.bill_payments
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_bill_payment_currency();

ALTER TABLE public.bill_payments ALTER COLUMN currency SET NOT NULL;

-- ------------------------------------------------------------
-- 3b. bank_transactions (D2)
-- ------------------------------------------------------------
ALTER TABLE public.bank_transactions ALTER COLUMN exchange_rate DROP DEFAULT;

CREATE OR REPLACE FUNCTION public._tg_stamp_bank_transaction_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s record;
  v_account_currency text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.original_currency IS DISTINCT FROM OLD.original_currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND (COALESCE(OLD.is_reconciled, false) OR OLD.journal_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Currency and rate of a reconciled or posted bank transaction are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT ba.currency INTO v_account_currency
    FROM public.bank_accounts ba WHERE ba.id = NEW.bank_account_id;

  IF TG_OP = 'INSERT'
     OR NEW.original_currency IS DISTINCT FROM OLD.original_currency
     OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id,
      NEW.business_id,
      COALESCE(NEW.original_currency, v_account_currency),
      NEW.transaction_date);
    NEW.original_currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_transactions_stamp_currency ON public.bank_transactions;
CREATE TRIGGER trg_bank_transactions_stamp_currency
  BEFORE INSERT OR UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_bank_transaction_currency();

-- ------------------------------------------------------------
-- 3c. rfq_quotations (D10)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_rfq_quotation_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s record;
  v_org uuid;
  v_biz uuid;
BEGIN
  SELECT r.organization_id, r.business_id INTO v_org, v_biz
    FROM public.rfqs r WHERE r.id = NEW.rfq_id;

  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND (OLD.superseded_by IS NOT NULL OR OLD.withdrawn_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Currency and rate of a superseded or withdrawn quotation are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      v_org, v_biz, NEW.currency, COALESCE(NEW.submitted_at::date, CURRENT_DATE));
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rfq_quotations_stamp_currency ON public.rfq_quotations;
CREATE TRIGGER trg_rfq_quotations_stamp_currency
  BEFORE INSERT OR UPDATE ON public.rfq_quotations
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_rfq_quotation_currency();

-- ------------------------------------------------------------
-- 3d. Posted-immutability guards (D9)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_estimate_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted_any(ARRAY['estimate','estimates'], OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted estimate are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.issue_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public._tg_stamp_sales_order_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted_any(ARRAY['sales_order','sales_orders'], OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted sales order are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.order_date IS DISTINCT FROM OLD.order_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.order_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public._tg_stamp_customer_refund_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted_any(ARRAY['customer_refund','customer_refunds'], OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted customer refund are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.refund_date IS DISTINCT FROM OLD.refund_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.refund_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public._tg_stamp_po_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted_any(ARRAY['purchase_order','purchase_orders'], OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted purchase order are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.order_date IS DISTINCT FROM OLD.order_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate = 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id, NEW.business_id, NEW.currency, NEW.order_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 3e. Invoice re-stamp symmetry with bills (D11)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tg_stamp_invoice_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted('invoice', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted invoice are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate <= 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(NEW.organization_id, NEW.business_id, NEW.currency, NEW.issue_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END; $$;

-- ------------------------------------------------------------
-- Read-only stamped-rate review report (never rewrites history)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fx_stamped_rate_review(p_business_id uuid)
RETURNS TABLE (
  document_kind text,
  document_id uuid,
  document_date date,
  currency text,
  stamped_rate numeric,
  rate_book_rate numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid;
  v_base text;
BEGIN
  SELECT b.organization_id, upper(b.base_currency) INTO v_org, v_base
    FROM public.businesses b WHERE b.id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Unknown business' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_finance_manager(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Only finance managers may review stamped exchange rates'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT 'bill_payment'::text, bp.id, bp.payment_date, upper(bp.currency), bp.currency_rate,
         public.resolve_exchange_rate(bp.organization_id, bp.business_id, bp.currency, bp.payment_date)
    FROM public.bill_payments bp
   WHERE bp.business_id = p_business_id
     AND upper(bp.currency) <> v_base
     AND bp.currency_rate IS DISTINCT FROM
         public.resolve_exchange_rate(bp.organization_id, bp.business_id, bp.currency, bp.payment_date)
  UNION ALL
  SELECT 'bank_transaction'::text, bt.id, bt.transaction_date, upper(bt.original_currency), bt.exchange_rate,
         public.resolve_exchange_rate(bt.organization_id, bt.business_id, bt.original_currency, bt.transaction_date)
    FROM public.bank_transactions bt
   WHERE bt.business_id = p_business_id
     AND bt.original_currency IS NOT NULL
     AND upper(bt.original_currency) <> v_base
     AND bt.exchange_rate IS DISTINCT FROM
         public.resolve_exchange_rate(bt.organization_id, bt.business_id, bt.original_currency, bt.transaction_date);
END;
$$;

REVOKE ALL ON FUNCTION public.fx_stamped_rate_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fx_stamped_rate_review(uuid) TO authenticated;