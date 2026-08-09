-- 1. Bills can carry the structured payment term (P0-1)
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS payment_term_id uuid REFERENCES public.payment_terms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bills_payment_term_id ON public.bills(payment_term_id);

-- 2. The single resolver: override -> party default -> business default (P0-2, P0-4)
CREATE OR REPLACE FUNCTION public.resolve_payment_term(
  p_organization_id uuid,
  p_business_id uuid,
  p_contact_id uuid DEFAULT NULL,
  p_override_term_id uuid DEFAULT NULL
)
RETURNS TABLE (payment_term_id uuid, days integer, name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Tier 1: explicit document-level override.
  IF p_override_term_id IS NOT NULL THEN
    SELECT pt.id INTO v_id
    FROM public.payment_terms pt
    WHERE pt.id = p_override_term_id
      AND pt.organization_id = p_organization_id
      AND pt.is_active
    LIMIT 1;
  END IF;

  -- Tier 2: the counterparty's own default term.
  IF v_id IS NULL AND p_contact_id IS NOT NULL THEN
    SELECT pt.id INTO v_id
    FROM public.contacts c
    JOIN public.payment_terms pt ON pt.id = c.payment_term_id
    WHERE c.id = p_contact_id
      AND pt.organization_id = p_organization_id
      AND pt.is_active
    LIMIT 1;
  END IF;

  -- Tier 3: the business default term.
  IF v_id IS NULL THEN
    SELECT pt.id INTO v_id
    FROM public.payment_terms pt
    WHERE pt.organization_id = p_organization_id
      AND (p_business_id IS NULL OR pt.business_id = p_business_id)
      AND pt.is_active
      AND pt.is_default
    ORDER BY pt.days
    LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT pt.id, pt.days, pt.name
  FROM public.payment_terms pt
  WHERE pt.id = v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_payment_term(uuid, uuid, uuid, uuid) TO authenticated, service_role;

-- 3. Fill-on-insert: every creation path inherits the resolved term (P0-3).
--    Additive only. An explicitly supplied term is never overwritten, and
--    due_date is left exactly as the caller recorded it, so confirmed
--    document truth and historical due dates are unaffected.
CREATE OR REPLACE FUNCTION public._fill_document_payment_term()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact uuid;
  v_term uuid;
BEGIN
  IF NEW.payment_term_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'bills' THEN
    v_contact := NEW.vendor_id;
  ELSE
    v_contact := NEW.contact_id;
  END IF;

  SELECT r.payment_term_id INTO v_term
  FROM public.resolve_payment_term(
    NEW.organization_id, NEW.business_id, v_contact, NULL
  ) r
  LIMIT 1;

  NEW.payment_term_id := v_term;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoices_fill_payment_term ON public.invoices;
CREATE TRIGGER trg_invoices_fill_payment_term
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._fill_document_payment_term();

DROP TRIGGER IF EXISTS trg_bills_fill_payment_term ON public.bills;
CREATE TRIGGER trg_bills_fill_payment_term
  BEFORE INSERT ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public._fill_document_payment_term();

DROP TRIGGER IF EXISTS trg_sales_orders_fill_payment_term ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_fill_payment_term
  BEFORE INSERT ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public._fill_document_payment_term();

COMMENT ON FUNCTION public.resolve_payment_term(uuid, uuid, uuid, uuid) IS
  'Canonical payment-term cascade: document override -> contact/supplier default -> business default. The ONLY sanctioned way to resolve a payment term; do not re-implement the cascade in app code.';
COMMENT ON COLUMN public.bills.payment_term_id IS
  'Structured payment term this bill was raised under. Snapshotted at creation; never re-resolved from vendor master data.';