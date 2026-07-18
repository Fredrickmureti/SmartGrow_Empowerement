
-- =========================================================================
-- P2: Procurement Contracts & Agreements
-- =========================================================================

-- 1. procurement_contracts ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.procurement_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  contract_number text NOT NULL,
  title text,
  kind text NOT NULL DEFAULT 'rate'
    CHECK (kind IN ('rate','volume','blanket','framework')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','expired','terminated','superseded')),
  currency text NOT NULL DEFAULT 'USD',
  start_date date NOT NULL,
  end_date date,
  ceiling_value numeric(18,4),
  utilized_value numeric(18,4) NOT NULL DEFAULT 0,
  auto_renew boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  terminated_by uuid,
  terminated_at timestamptz,
  terminated_reason text,
  is_sample_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, contract_number),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (ceiling_value IS NULL OR ceiling_value >= 0)
);
CREATE INDEX IF NOT EXISTS procurement_contracts_business_idx
  ON public.procurement_contracts (business_id, status);
CREATE INDEX IF NOT EXISTS procurement_contracts_supplier_idx
  ON public.procurement_contracts (supplier_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.procurement_contracts TO authenticated;
GRANT ALL ON public.procurement_contracts TO service_role;

ALTER TABLE public.procurement_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY procurement_contracts_read ON public.procurement_contracts
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY procurement_contracts_write ON public.procurement_contracts
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

-- 2. procurement_contract_lines ------------------------------------------
CREATE TABLE IF NOT EXISTS public.procurement_contract_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.procurement_contracts(id) ON DELETE CASCADE,
  product_id uuid,
  description text NOT NULL,
  uom_id uuid,
  unit_price numeric(18,6) NOT NULL DEFAULT 0,
  min_quantity numeric(18,4),
  max_quantity numeric(18,4),
  ceiling_quantity numeric(18,4),
  ceiling_value numeric(18,4),
  utilized_quantity numeric(18,4) NOT NULL DEFAULT 0,
  utilized_value numeric(18,4) NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (unit_price >= 0)
);
CREATE INDEX IF NOT EXISTS procurement_contract_lines_contract_idx
  ON public.procurement_contract_lines (contract_id);
CREATE INDEX IF NOT EXISTS procurement_contract_lines_product_idx
  ON public.procurement_contract_lines (product_id) WHERE product_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.procurement_contract_lines TO authenticated;
GRANT ALL ON public.procurement_contract_lines TO service_role;

ALTER TABLE public.procurement_contract_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY procurement_contract_lines_read ON public.procurement_contract_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.procurement_contracts c
                 WHERE c.id = contract_id AND public.user_has_business_access(auth.uid(), c.business_id)));
CREATE POLICY procurement_contract_lines_write ON public.procurement_contract_lines
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.procurement_contracts c
                 WHERE c.id = contract_id AND public.user_has_business_access(auth.uid(), c.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.procurement_contracts c
                      WHERE c.id = contract_id AND public.user_has_business_access(auth.uid(), c.business_id)));

-- 3. procurement_contract_releases ---------------------------------------
CREATE TABLE IF NOT EXISTS public.procurement_contract_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.procurement_contracts(id) ON DELETE CASCADE,
  contract_line_id uuid REFERENCES public.procurement_contract_lines(id) ON DELETE SET NULL,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE CASCADE,
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  value numeric(18,4) NOT NULL DEFAULT 0,
  released_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, purchase_order_item_id)
);
CREATE INDEX IF NOT EXISTS procurement_contract_releases_contract_idx
  ON public.procurement_contract_releases (contract_id);
CREATE INDEX IF NOT EXISTS procurement_contract_releases_po_idx
  ON public.procurement_contract_releases (purchase_order_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.procurement_contract_releases TO authenticated;
GRANT ALL ON public.procurement_contract_releases TO service_role;

ALTER TABLE public.procurement_contract_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY procurement_contract_releases_read ON public.procurement_contract_releases
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.procurement_contracts c
                 WHERE c.id = contract_id AND public.user_has_business_access(auth.uid(), c.business_id)));
CREATE POLICY procurement_contract_releases_write ON public.procurement_contract_releases
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.procurement_contracts c
                 WHERE c.id = contract_id AND public.user_has_business_access(auth.uid(), c.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.procurement_contracts c
                      WHERE c.id = contract_id AND public.user_has_business_access(auth.uid(), c.business_id)));

-- 4. PO linkage ----------------------------------------------------------
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS contract_id uuid
    REFERENCES public.procurement_contracts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS purchase_orders_contract_idx
  ON public.purchase_orders (contract_id) WHERE contract_id IS NOT NULL;

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS contract_line_id uuid
    REFERENCES public.procurement_contract_lines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS purchase_order_items_contract_line_idx
  ON public.purchase_order_items (contract_line_id) WHERE contract_line_id IS NOT NULL;

-- 5. updated_at triggers -------------------------------------------------
DROP TRIGGER IF EXISTS trg_procurement_contracts_updated ON public.procurement_contracts;
CREATE TRIGGER trg_procurement_contracts_updated
  BEFORE UPDATE ON public.procurement_contracts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_procurement_contract_lines_updated ON public.procurement_contract_lines;
CREATE TRIGGER trg_procurement_contract_lines_updated
  BEFORE UPDATE ON public.procurement_contract_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Ceiling enforcement + release ledger on PO approval -----------------
CREATE OR REPLACE FUNCTION public.tg_purchase_order_contract_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract RECORD;
  v_po_value numeric(18,4);
  v_item RECORD;
  v_line RECORD;
BEGIN
  -- Only fire on transition into approved.
  IF NOT (lower(coalesce(NEW.status,'')) = 'approved'
          AND lower(coalesce(OLD.status,'')) <> 'approved') THEN
    RETURN NEW;
  END IF;
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_contract
  FROM public.procurement_contracts
  WHERE id = NEW.contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract % not found', NEW.contract_id USING ERRCODE='P0002';
  END IF;

  IF v_contract.status <> 'active' THEN
    RAISE EXCEPTION 'Contract % is % — cannot draw a PO from it',
      v_contract.contract_number, v_contract.status USING ERRCODE='22023';
  END IF;
  IF v_contract.end_date IS NOT NULL AND v_contract.end_date < current_date THEN
    RAISE EXCEPTION 'Contract % expired on %', v_contract.contract_number, v_contract.end_date
      USING ERRCODE='22023';
  END IF;
  IF v_contract.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'Contract % belongs to a different business', v_contract.contract_number
      USING ERRCODE='22023';
  END IF;
  IF v_contract.supplier_id NOT IN (
    SELECT id FROM public.suppliers WHERE contact_id = NEW.vendor_id
  ) THEN
    RAISE EXCEPTION 'Contract supplier does not match PO vendor' USING ERRCODE='22023';
  END IF;

  v_po_value := coalesce(NEW.total, 0);

  -- Header ceiling
  IF v_contract.ceiling_value IS NOT NULL
     AND (v_contract.utilized_value + v_po_value) > v_contract.ceiling_value THEN
    INSERT INTO public.business_event_outbox
      (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
    VALUES (NEW.organization_id, 'procurement.contract.ceiling_breached_attempt',
            'purchase_order', NEW.id,
            jsonb_build_object('contract_id', v_contract.id, 'po_value', v_po_value,
                               'utilized_value', v_contract.utilized_value,
                               'ceiling_value', v_contract.ceiling_value),
            'procurement.contract.ceiling_breached_attempt:' || NEW.id::text,
            auth.uid(), 'procurement')
    ON CONFLICT (idempotency_key) DO NOTHING;
    RAISE EXCEPTION 'Contract % ceiling exceeded (utilized % + PO % > %)',
      v_contract.contract_number, v_contract.utilized_value, v_po_value, v_contract.ceiling_value
      USING ERRCODE='22023';
  END IF;

  -- Line-level ceilings
  FOR v_item IN
    SELECT * FROM public.purchase_order_items
    WHERE purchase_order_id = NEW.id AND contract_line_id IS NOT NULL
  LOOP
    SELECT * INTO v_line
    FROM public.procurement_contract_lines
    WHERE id = v_item.contract_line_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF v_line.ceiling_quantity IS NOT NULL
       AND (v_line.utilized_quantity + coalesce(v_item.quantity,0)) > v_line.ceiling_quantity THEN
      RAISE EXCEPTION 'Contract line "%" quantity ceiling exceeded', v_line.description
        USING ERRCODE='22023';
    END IF;
    IF v_line.ceiling_value IS NOT NULL
       AND (v_line.utilized_value + coalesce(v_item.line_total,0)) > v_line.ceiling_value THEN
      RAISE EXCEPTION 'Contract line "%" value ceiling exceeded', v_line.description
        USING ERRCODE='22023';
    END IF;

    UPDATE public.procurement_contract_lines
    SET utilized_quantity = utilized_quantity + coalesce(v_item.quantity,0),
        utilized_value    = utilized_value    + coalesce(v_item.line_total,0),
        updated_at = now()
    WHERE id = v_line.id;

    INSERT INTO public.procurement_contract_releases
      (contract_id, contract_line_id, purchase_order_id, purchase_order_item_id,
       quantity, value, released_by)
    VALUES (v_contract.id, v_line.id, NEW.id, v_item.id,
            coalesce(v_item.quantity,0), coalesce(v_item.line_total,0), auth.uid())
    ON CONFLICT (purchase_order_id, purchase_order_item_id) DO NOTHING;
  END LOOP;

  -- Header-level release ledger row for unmapped-line PO totals
  INSERT INTO public.procurement_contract_releases
    (contract_id, contract_line_id, purchase_order_id, purchase_order_item_id,
     quantity, value, released_by)
  VALUES (v_contract.id, NULL, NEW.id, NULL, 0, v_po_value, auth.uid())
  ON CONFLICT (purchase_order_id, purchase_order_item_id) DO NOTHING;

  UPDATE public.procurement_contracts
  SET utilized_value = utilized_value + v_po_value, updated_at = now()
  WHERE id = v_contract.id;

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (NEW.organization_id, 'procurement.contract.release_recorded',
          'purchase_order', NEW.id,
          jsonb_build_object('contract_id', v_contract.id, 'value', v_po_value),
          'procurement.contract.release_recorded:' || NEW.id::text,
          auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_purchase_order_contract_ceiling ON public.purchase_orders;
CREATE TRIGGER trg_purchase_order_contract_ceiling
  BEFORE UPDATE OF status ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_purchase_order_contract_ceiling();

-- 7. Lifecycle RPCs ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_procurement_contract(
  p_business_id uuid,
  p_supplier_id uuid,
  p_contract_number text,
  p_title text,
  p_kind text,
  p_currency text,
  p_start_date date,
  p_end_date date,
  p_ceiling_value numeric,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_contract_id uuid;
  v_line jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.suppliers
   WHERE id = p_supplier_id AND business_id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Supplier not found in business' USING ERRCODE='P0002';
  END IF;

  INSERT INTO public.procurement_contracts
    (organization_id, business_id, supplier_id, contract_number, title, kind,
     currency, start_date, end_date, ceiling_value, notes, created_by)
  VALUES (v_org, p_business_id, p_supplier_id, p_contract_number, p_title,
          coalesce(p_kind,'rate'), coalesce(p_currency,'USD'), p_start_date, p_end_date,
          p_ceiling_value, p_notes, v_uid)
  RETURNING id INTO v_contract_id;

  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      INSERT INTO public.procurement_contract_lines
        (contract_id, product_id, description, uom_id, unit_price,
         min_quantity, max_quantity, ceiling_quantity, ceiling_value, sort_order)
      VALUES (v_contract_id,
              nullif(v_line->>'product_id','')::uuid,
              coalesce(v_line->>'description',''),
              nullif(v_line->>'uom_id','')::uuid,
              coalesce((v_line->>'unit_price')::numeric, 0),
              (v_line->>'min_quantity')::numeric,
              (v_line->>'max_quantity')::numeric,
              (v_line->>'ceiling_quantity')::numeric,
              (v_line->>'ceiling_value')::numeric,
              coalesce((v_line->>'sort_order')::int, 0));
    END LOOP;
  END IF;

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_org, 'procurement.contract.created', 'procurement_contract', v_contract_id,
          jsonb_build_object('supplier_id', p_supplier_id, 'contract_number', p_contract_number),
          'procurement.contract.created:' || v_contract_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'contract_id', v_contract_id);
END $$;

CREATE OR REPLACE FUNCTION public.activate_procurement_contract(p_contract_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_c.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only draft contracts can be activated');
  END IF;
  IF v_c.created_by = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'Approver cannot equal creator');
  END IF;
  UPDATE public.procurement_contracts
     SET status='active', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_contract_id;
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_c.organization_id, 'procurement.contract.activated', 'procurement_contract', p_contract_id,
          jsonb_build_object('supplier_id', v_c.supplier_id),
          'procurement.contract.activated:' || p_contract_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.terminate_procurement_contract(
  p_contract_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_c.status IN ('terminated','expired','superseded') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contract already closed');
  END IF;
  UPDATE public.procurement_contracts
     SET status='terminated', terminated_by=v_uid, terminated_at=now(),
         terminated_reason=p_reason, updated_at=now()
   WHERE id=p_contract_id;
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_c.organization_id, 'procurement.contract.terminated', 'procurement_contract', p_contract_id,
          jsonb_build_object('reason', p_reason),
          'procurement.contract.terminated:' || p_contract_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.amend_procurement_contract(
  p_contract_id uuid,
  p_title text DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_ceiling_value numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_c.status NOT IN ('draft','active') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only draft/active contracts can be amended');
  END IF;
  UPDATE public.procurement_contracts
     SET title = coalesce(p_title, title),
         end_date = coalesce(p_end_date, end_date),
         ceiling_value = coalesce(p_ceiling_value, ceiling_value),
         notes = coalesce(p_notes, notes),
         updated_at = now()
   WHERE id=p_contract_id;
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_c.organization_id, 'procurement.contract.amended', 'procurement_contract', p_contract_id,
          jsonb_build_object('changed_by', v_uid),
          'procurement.contract.amended:' || p_contract_id::text || ':' || extract(epoch from now())::text,
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END $$;

-- 8. Expiry sweep --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.procurement_contracts_sweep_expiries()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row RECORD; v_count int := 0;
BEGIN
  FOR v_row IN
    SELECT * FROM public.procurement_contracts
     WHERE status = 'active'
       AND end_date IS NOT NULL
       AND end_date < current_date
     FOR UPDATE
  LOOP
    UPDATE public.procurement_contracts
       SET status='expired', updated_at=now()
     WHERE id = v_row.id;
    INSERT INTO public.business_event_outbox
      (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, source)
    VALUES (v_row.organization_id, 'procurement.contract.expired',
            'procurement_contract', v_row.id,
            jsonb_build_object('end_date', v_row.end_date),
            'procurement.contract.expired:' || v_row.id::text, 'procurement')
    ON CONFLICT (idempotency_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- 9. Topic registry ------------------------------------------------------
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description)
VALUES
  ('procurement.contract.created',                'procurement', ARRAY['finance','audit'],
     'Contract has been drafted.'),
  ('procurement.contract.activated',              'procurement', ARRAY['finance','audit'],
     'Contract approved and open for releases.'),
  ('procurement.contract.terminated',             'procurement', ARRAY['finance','audit'],
     'Contract terminated before end date.'),
  ('procurement.contract.expired',                'procurement', ARRAY['finance','audit'],
     'Contract passed its end date and was closed.'),
  ('procurement.contract.amended',                'procurement', ARRAY['audit'],
     'Contract header or ceiling was amended.'),
  ('procurement.contract.release_recorded',       'procurement', ARRAY['finance','analytics'],
     'A PO drew value from an active contract.'),
  ('procurement.contract.ceiling_breached_attempt','procurement', ARRAY['audit','risk'],
     'A PO approval was blocked because it would exceed the contract ceiling.')
ON CONFLICT (topic_prefix) DO UPDATE
  SET producer_domain = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description = EXCLUDED.description,
      updated_at = now();
