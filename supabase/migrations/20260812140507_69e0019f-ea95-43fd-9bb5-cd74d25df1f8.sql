-- ═══ C10. Single item-terms engine ═══════════════════════════════════════
ALTER TABLE public.supplier_item_terms
  ADD COLUMN IF NOT EXISTS unit_price numeric,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Missing referential integrity (the table shipped with none).
DO $$ BEGIN
  ALTER TABLE public.supplier_item_terms
    ADD CONSTRAINT supplier_item_terms_supplier_id_fkey
    FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.supplier_item_terms
    ADD CONSTRAINT supplier_item_terms_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ensure a supplier role exists for every party that has pricing.
INSERT INTO public.suppliers (organization_id, business_id, contact_id, supplier_code, lifecycle_state)
SELECT DISTINCT c.organization_id, c.business_id, c.id,
       public.next_supplier_code(c.business_id), 'draft'
  FROM public.vendor_pricelists v
  JOIN public.contacts c ON c.id = v.vendor_id
 WHERE NOT EXISTS (SELECT 1 FROM public.suppliers s
                    WHERE s.business_id = c.business_id AND s.contact_id = c.id)
ON CONFLICT DO NOTHING;

-- Migrate the pricing data onto the canonical, supplier-keyed table.
INSERT INTO public.supplier_item_terms (
  organization_id, business_id, product_id, supplier_id, preferred_rank,
  lead_time_days, min_order_qty, price_break_tiers, currency_code,
  effective_from, effective_to, notes, unit_price, is_active, branch_id, created_at)
SELECT v.organization_id, v.business_id, v.product_id, s.id,
       CASE WHEN v.is_preferred THEN 1 ELSE 10 END,
       v.lead_time_days, v.min_order_qty, '[]'::jsonb, v.currency,
       COALESCE(v.valid_from, CURRENT_DATE), v.valid_until, v.notes,
       v.unit_price, v.is_active, v.branch_id, v.created_at
  FROM public.vendor_pricelists v
  JOIN public.suppliers s
    ON s.business_id = v.business_id AND s.contact_id = v.vendor_id
 WHERE NOT EXISTS (
   SELECT 1 FROM public.supplier_item_terms t
    WHERE t.business_id = v.business_id AND t.supplier_id = s.id
      AND t.product_id = v.product_id
      AND t.effective_from = COALESCE(v.valid_from, CURRENT_DATE));

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_item_terms_version
  ON public.supplier_item_terms (business_id, supplier_id, product_id, effective_from);

UPDATE public.supplier_item_terms t
   SET organization_id = s.organization_id
  FROM public.suppliers s
 WHERE s.id = t.supplier_id AND t.organization_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_item_terms TO authenticated;
GRANT ALL ON public.supplier_item_terms TO service_role;
ALTER TABLE public.supplier_item_terms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supplier_item_terms_rw" ON public.supplier_item_terms;
CREATE POLICY "supplier_item_terms_rw"
  ON public.supplier_item_terms FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

-- Replace the duplicate table with a party-keyed compatibility view.
DROP TABLE IF EXISTS public.vendor_pricelists CASCADE;

CREATE VIEW public.vendor_pricelists
WITH (security_invoker = true) AS
SELECT t.id,
       t.organization_id,
       t.business_id,
       s.contact_id      AS vendor_id,
       t.supplier_id,
       t.product_id,
       t.unit_price,
       t.currency_code   AS currency,
       t.min_order_qty::integer AS min_order_qty,
       t.lead_time_days,
       (t.preferred_rank <= 1) AS is_preferred,
       t.effective_from  AS valid_from,
       t.effective_to    AS valid_until,
       t.notes,
       t.is_active,
       t.created_at,
       t.updated_at,
       t.branch_id
  FROM public.supplier_item_terms t
  JOIN public.suppliers s ON s.id = t.supplier_id;

GRANT SELECT ON public.vendor_pricelists TO authenticated;
GRANT ALL ON public.vendor_pricelists TO service_role;

CREATE OR REPLACE FUNCTION public._vendor_pricelists_dml()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_supplier_id uuid; v_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.supplier_item_terms WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  v_supplier_id := public.ensure_supplier_for_contact(NEW.vendor_id);
  IF v_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Vendor % is not a supplier party', NEW.vendor_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.supplier_item_terms (
      organization_id, business_id, supplier_id, product_id, unit_price,
      currency_code, min_order_qty, lead_time_days, preferred_rank,
      effective_from, effective_to, notes, is_active, branch_id, created_by)
    VALUES (NEW.organization_id, NEW.business_id, v_supplier_id, NEW.product_id, NEW.unit_price,
            COALESCE(NEW.currency, 'KES'), COALESCE(NEW.min_order_qty, 1),
            COALESCE(NEW.lead_time_days, 0),
            CASE WHEN COALESCE(NEW.is_preferred, false) THEN 1 ELSE 10 END,
            COALESCE(NEW.valid_from, CURRENT_DATE), NEW.valid_until, NEW.notes,
            COALESCE(NEW.is_active, true), NEW.branch_id, auth.uid())
    RETURNING id INTO v_id;
    NEW.id := v_id;
    NEW.supplier_id := v_supplier_id;
    RETURN NEW;
  END IF;

  UPDATE public.supplier_item_terms
     SET supplier_id = v_supplier_id,
         product_id = NEW.product_id,
         unit_price = NEW.unit_price,
         currency_code = COALESCE(NEW.currency, currency_code),
         min_order_qty = COALESCE(NEW.min_order_qty, min_order_qty),
         lead_time_days = COALESCE(NEW.lead_time_days, lead_time_days),
         preferred_rank = CASE WHEN COALESCE(NEW.is_preferred, false) THEN 1 ELSE 10 END,
         effective_from = COALESCE(NEW.valid_from, effective_from),
         effective_to = NEW.valid_until,
         notes = NEW.notes,
         is_active = COALESCE(NEW.is_active, is_active),
         branch_id = NEW.branch_id,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = OLD.id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_vendor_pricelists_dml
  INSTEAD OF INSERT OR UPDATE OR DELETE ON public.vendor_pricelists
  FOR EACH ROW EXECUTE FUNCTION public._vendor_pricelists_dml();

-- ═══ D11. Supplier defaults + document party snapshots ═══════════════════
CREATE OR REPLACE FUNCTION public.resolve_supplier_defaults(
  p_business_id uuid, p_contact_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'supplier_id', s.id,
    'supplier_code', s.supplier_code,
    'lifecycle_state', s.lifecycle_state,
    'currency', COALESCE(s.default_currency, c.default_currency),
    'incoterms', s.default_incoterms,
    'payment_term_id', COALESCE(s.default_payment_term_id, c.payment_term_id),
    'lead_time_days', s.default_lead_time_days,
    'minimum_order_value', s.minimum_order_value)
    FROM public.suppliers s
    JOIN public.contacts c ON c.id = s.contact_id
   WHERE s.business_id = p_business_id AND s.contact_id = p_contact_id;
$$;

ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS party_snapshot jsonb;
ALTER TABLE public.bills            ADD COLUMN IF NOT EXISTS party_snapshot jsonb;

CREATE OR REPLACE FUNCTION public._stamp_party_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NEW.vendor_id IS NULL OR NEW.party_snapshot IS NOT NULL THEN RETURN NEW; END IF;
  SELECT jsonb_build_object(
           'captured_at', now(),
           'contact_id', c.id,
           'name', c.name,
           'tax_id', c.tax_id,
           'email', c.email,
           'phone', c.phone,
           'supplier_id', s.id,
           'supplier_code', s.supplier_code,
           'lifecycle_state', s.lifecycle_state,
           'default_currency', s.default_currency,
           'default_incoterms', s.default_incoterms,
           'default_payment_term_id', COALESCE(s.default_payment_term_id, c.payment_term_id),
           'default_lead_time_days', s.default_lead_time_days)
    INTO v
    FROM public.contacts c
    LEFT JOIN public.suppliers s
      ON s.contact_id = c.id AND s.business_id = NEW.business_id
   WHERE c.id = NEW.vendor_id;
  NEW.party_snapshot := v;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_po_party_snapshot ON public.purchase_orders;
CREATE TRIGGER trg_po_party_snapshot
  BEFORE INSERT ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._stamp_party_snapshot();

DROP TRIGGER IF EXISTS trg_bills_party_snapshot ON public.bills;
CREATE TRIGGER trg_bills_party_snapshot
  BEFORE INSERT ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public._stamp_party_snapshot();

-- ═══ D12. Downstream event coverage ══════════════════════════════════════
CREATE OR REPLACE FUNCTION public._emit_purchase_return_outbox()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source)
  VALUES (NEW.organization_id, NEW.branch_id,
          'purchase_return.' || NEW.status, 'purchase_return', NEW.id,
          jsonb_build_object('business_id', NEW.business_id, 'vendor_id', NEW.vendor_id,
                             'return_number', NEW.return_number, 'status', NEW.status,
                             'total', NEW.total, 'currency', NEW.currency,
                             'row_version', NEW.row_version),
          'purchase_return.' || NEW.status || ':' || NEW.id::text || ':' || NEW.row_version::text,
          auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_purchase_returns_outbox ON public.purchase_returns;
CREATE TRIGGER trg_purchase_returns_outbox
  AFTER INSERT OR UPDATE OF status ON public.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public._emit_purchase_return_outbox();

CREATE OR REPLACE FUNCTION public._emit_bill_lifecycle_outbox()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source)
  VALUES (NEW.organization_id, NEW.branch_id,
          'bill.' || NEW.status::text, 'bill', NEW.id,
          jsonb_build_object('business_id', NEW.business_id, 'vendor_id', NEW.vendor_id,
                             'status', NEW.status, 'total', NEW.total, 'currency', NEW.currency),
          'bill.' || NEW.status::text || ':' || NEW.id::text, auth.uid(), 'ap')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bills_lifecycle_outbox ON public.bills;
CREATE TRIGGER trg_bills_lifecycle_outbox
  AFTER UPDATE OF status ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public._emit_bill_lifecycle_outbox();

CREATE OR REPLACE FUNCTION public._emit_bill_payment_outbox()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source)
  VALUES (NEW.organization_id, NEW.branch_id, 'bill_payment.recorded', 'bill_payment', NEW.id,
          jsonb_build_object('business_id', NEW.business_id, 'vendor_id', NEW.vendor_id,
                             'amount', NEW.amount, 'currency', NEW.currency),
          'bill_payment.recorded:' || NEW.id::text, auth.uid(), 'ap')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bill_payments_outbox ON public.bill_payments;
CREATE TRIGGER trg_bill_payments_outbox
  AFTER INSERT ON public.bill_payments
  FOR EACH ROW EXECUTE FUNCTION public._emit_bill_payment_outbox();