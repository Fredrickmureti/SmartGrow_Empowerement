
-- ============================================================
-- Procurement Batch H — 3/4-way match state machine
-- ============================================================

-- Enums --------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.bill_match_state AS ENUM (
    'matched','under_billed','over_billed','price_variance','no_po'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bill_match_exception_state AS ENUM (
    'none','pending_review','approved','rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Table 1: tolerance policy ----------------------------------
CREATE TABLE IF NOT EXISTS public.bill_match_tolerance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  qty_tolerance_pct numeric NOT NULL DEFAULT 0,
  price_tolerance_pct numeric NOT NULL DEFAULT 0,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_match_tolerance_policies TO authenticated;
GRANT ALL ON public.bill_match_tolerance_policies TO service_role;
ALTER TABLE public.bill_match_tolerance_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bmt tenant read" ON public.bill_match_tolerance_policies
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "bmt tenant write" ON public.bill_match_tolerance_policies
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_bmt_updated_at
  BEFORE UPDATE ON public.bill_match_tolerance_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Table 2: match results (one row per bill) -------------------
CREATE TABLE IF NOT EXISTS public.bill_match_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  bill_id uuid NOT NULL UNIQUE REFERENCES public.bills(id) ON DELETE CASCADE,
  purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  landed_cost_bill_id uuid REFERENCES public.landed_cost_bills(id) ON DELETE SET NULL,
  match_state public.bill_match_state NOT NULL,
  exception_state public.bill_match_exception_state NOT NULL DEFAULT 'none',
  qty_variance numeric NOT NULL DEFAULT 0,
  price_variance numeric NOT NULL DEFAULT 0,
  landed_cost_uplift numeric NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_by uuid,
  matched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_match_results TO authenticated;
GRANT ALL ON public.bill_match_results TO service_role;
ALTER TABLE public.bill_match_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bmr tenant read" ON public.bill_match_results
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "bmr tenant write" ON public.bill_match_results
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER trg_bmr_updated_at
  BEFORE UPDATE ON public.bill_match_results
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Table 3: exception audit log -------------------------------
CREATE TABLE IF NOT EXISTS public.bill_match_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  match_state public.bill_match_state NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_by uuid,
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_match_exceptions TO authenticated;
GRANT ALL ON public.bill_match_exceptions TO service_role;
ALTER TABLE public.bill_match_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bme tenant read" ON public.bill_match_exceptions
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "bme tenant write" ON public.bill_match_exceptions
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE INDEX IF NOT EXISTS idx_bme_bill ON public.bill_match_exceptions(bill_id);
CREATE INDEX IF NOT EXISTS idx_bme_business_pending
  ON public.bill_match_exceptions(business_id) WHERE resolved_at IS NULL;

-- Outbox helper -----------------------------------------------
CREATE OR REPLACE FUNCTION public._emit_bill_match_outbox(
  _bill_id uuid, _state text, _payload jsonb
) RETURNS void
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_org uuid; v_branch uuid;
BEGIN
  SELECT organization_id, branch_id INTO v_org, v_branch
    FROM public.bills WHERE id=_bill_id;
  INSERT INTO public.business_event_outbox
    (org_id, branch_id, source, event_type,
     source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES
    (v_org, v_branch, 'procurement',
     'procurement.bill.match.' || _state,
     'bill', _bill_id, _payload,
     'procurement.bill.match.' || _state || ':' || _bill_id::text || ':' || _state,
     'pending', auth.uid(), now())
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

-- Core RPC: match_bill_atomic (also drives 4-way when landed cost supplied)
CREATE OR REPLACE FUNCTION public.match_bill_atomic(
  _bill_id uuid,
  _actor uuid,
  _landed_cost_bill_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_bill RECORD;
  v_po_id uuid;
  v_qty_tol numeric := 0;
  v_price_tol numeric := 0;
  v_line RECORD;
  v_received numeric;
  v_qty_var numeric := 0;
  v_price_var numeric := 0;
  v_worst public.bill_match_state := 'matched';
  v_details jsonb := '[]'::jsonb;
  v_uplift numeric := 0;
  v_lc_total numeric := 0;
  v_po_total numeric := 0;
  v_result_id uuid;
  v_target_price numeric;
  v_price_diff numeric;
  v_has_no_po_line boolean := false;
BEGIN
  IF _actor IS NULL THEN RAISE EXCEPTION 'actor is required'; END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id=_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill % not found', _bill_id; END IF;
  IF NOT public.user_has_business_access(_actor, v_bill.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF v_bill.approved_by IS NOT NULL AND v_bill.approved_by = _actor THEN
    RAISE EXCEPTION 'SoD violation: bill.match actor % also approved bill %',
      _actor, _bill_id USING ERRCODE='42501';
  END IF;

  v_po_id := v_bill.purchase_order_id;

  -- No PO case: cannot 3-way match, park as exception
  IF v_po_id IS NULL THEN
    INSERT INTO public.bill_match_results
      (organization_id, business_id, bill_id, purchase_order_id, landed_cost_bill_id,
       match_state, exception_state, qty_variance, price_variance, landed_cost_uplift,
       details, matched_by)
    VALUES (v_bill.organization_id, v_bill.business_id, _bill_id, NULL, _landed_cost_bill_id,
            'no_po', 'pending_review', 0, 0, 0, '[]'::jsonb, _actor)
    ON CONFLICT (bill_id) DO UPDATE SET
      match_state='no_po', exception_state='pending_review',
      landed_cost_bill_id=EXCLUDED.landed_cost_bill_id,
      matched_by=_actor, matched_at=now(), updated_at=now()
    RETURNING id INTO v_result_id;

    INSERT INTO public.bill_match_exceptions
      (organization_id, business_id, bill_id, match_state, reason, details, raised_by)
    VALUES (v_bill.organization_id, v_bill.business_id, _bill_id, 'no_po',
            'Bill has no linked purchase order',
            jsonb_build_object('bill_id', _bill_id), _actor);

    PERFORM public._emit_bill_match_outbox(_bill_id, 'no_po',
      jsonb_build_object('bill_id', _bill_id, 'match_state', 'no_po'));
    RETURN jsonb_build_object('match_state','no_po','result_id',v_result_id);
  END IF;

  -- lock PO
  PERFORM 1 FROM public.purchase_orders WHERE id=v_po_id FOR UPDATE;

  -- resolve tolerances
  SELECT COALESCE(qty_tolerance_pct,0), COALESCE(price_tolerance_pct,0)
    INTO v_qty_tol, v_price_tol
    FROM public.bill_match_tolerance_policies
   WHERE business_id=v_bill.business_id
     AND effective_from <= now()
     AND (effective_to IS NULL OR effective_to > now())
   ORDER BY effective_from DESC LIMIT 1;
  v_qty_tol := COALESCE(v_qty_tol, 0);
  v_price_tol := COALESCE(v_price_tol, 0);

  -- landed cost uplift (fractional over PO subtotal)
  IF _landed_cost_bill_id IS NOT NULL THEN
    SELECT COALESCE(total_amount,0) INTO v_lc_total
      FROM public.landed_cost_bills WHERE id=_landed_cost_bill_id;
    SELECT COALESCE(SUM(quantity*unit_price),0) INTO v_po_total
      FROM public.purchase_order_items WHERE purchase_order_id=v_po_id;
    IF v_po_total > 0 THEN v_uplift := v_lc_total / v_po_total; END IF;
  END IF;

  -- per bill line
  FOR v_line IN
    SELECT bi.id AS bill_item_id, bi.purchase_order_item_id AS po_item_id,
           bi.quantity AS billed_qty, bi.unit_price AS billed_price,
           poi.quantity AS ordered_qty, poi.quantity_received AS received_qty,
           poi.unit_price AS po_price
      FROM public.bill_items bi
      LEFT JOIN public.purchase_order_items poi
        ON poi.id = bi.purchase_order_item_id
     WHERE bi.bill_id = _bill_id
  LOOP
    IF v_line.po_item_id IS NULL THEN
      v_has_no_po_line := true;
      v_details := v_details || jsonb_build_array(jsonb_build_object(
        'bill_item_id', v_line.bill_item_id,
        'reason', 'bill_line_not_linked_to_po_line'));
      CONTINUE;
    END IF;

    v_received := COALESCE(v_line.received_qty, 0);

    -- Qty variance vs received (billed against received per policy)
    IF v_line.billed_qty > v_received * (1 + v_qty_tol/100.0) THEN
      v_qty_var := v_qty_var + (v_line.billed_qty - v_received);
      v_worst := 'over_billed';
    ELSIF v_line.billed_qty < v_received * (1 - v_qty_tol/100.0) THEN
      v_qty_var := v_qty_var + (v_line.billed_qty - v_received);
      IF v_worst <> 'over_billed' THEN v_worst := 'under_billed'; END IF;
    END IF;

    -- Price variance vs PO price grossed up by landed-cost uplift
    v_target_price := COALESCE(v_line.po_price, 0) * (1 + v_uplift);
    v_price_diff := v_line.billed_price - v_target_price;
    v_price_var := v_price_var + v_price_diff * v_line.billed_qty;
    IF v_target_price > 0
       AND ABS(v_price_diff) > v_target_price * (v_price_tol/100.0) THEN
      IF v_worst = 'matched' THEN v_worst := 'price_variance'; END IF;
    END IF;

    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'bill_item_id', v_line.bill_item_id,
      'po_item_id',   v_line.po_item_id,
      'billed_qty',   v_line.billed_qty,
      'received_qty', v_received,
      'billed_price', v_line.billed_price,
      'po_price',     v_line.po_price,
      'target_price', v_target_price,
      'landed_uplift', v_uplift));
  END LOOP;

  IF v_has_no_po_line AND v_worst = 'matched' THEN
    v_worst := 'no_po';
  END IF;

  INSERT INTO public.bill_match_results
    (organization_id, business_id, bill_id, purchase_order_id, landed_cost_bill_id,
     match_state, exception_state, qty_variance, price_variance, landed_cost_uplift,
     details, matched_by)
  VALUES (v_bill.organization_id, v_bill.business_id, _bill_id, v_po_id, _landed_cost_bill_id,
          v_worst,
          CASE WHEN v_worst = 'matched'
               THEN 'none'::public.bill_match_exception_state
               ELSE 'pending_review'::public.bill_match_exception_state END,
          v_qty_var, v_price_var, v_uplift, v_details, _actor)
  ON CONFLICT (bill_id) DO UPDATE SET
    purchase_order_id   = EXCLUDED.purchase_order_id,
    landed_cost_bill_id = EXCLUDED.landed_cost_bill_id,
    match_state         = EXCLUDED.match_state,
    exception_state     = EXCLUDED.exception_state,
    qty_variance        = EXCLUDED.qty_variance,
    price_variance      = EXCLUDED.price_variance,
    landed_cost_uplift  = EXCLUDED.landed_cost_uplift,
    details             = EXCLUDED.details,
    matched_by          = EXCLUDED.matched_by,
    matched_at          = now(),
    updated_at          = now()
  RETURNING id INTO v_result_id;

  IF v_worst <> 'matched' THEN
    INSERT INTO public.bill_match_exceptions
      (organization_id, business_id, bill_id, match_state, reason, details, raised_by)
    VALUES (v_bill.organization_id, v_bill.business_id, _bill_id, v_worst,
            format('%s variance detected on bill match', v_worst),
            jsonb_build_object(
              'qty_variance', v_qty_var,
              'price_variance', v_price_var,
              'landed_cost_uplift', v_uplift), _actor);
  END IF;

  PERFORM public._emit_bill_match_outbox(_bill_id, v_worst::text, jsonb_build_object(
    'bill_id', _bill_id,
    'match_state', v_worst,
    'qty_variance', v_qty_var,
    'price_variance', v_price_var,
    'landed_cost_bill_id', _landed_cost_bill_id));

  RETURN jsonb_build_object(
    'match_state', v_worst,
    'result_id',   v_result_id,
    'qty_variance', v_qty_var,
    'price_variance', v_price_var,
    'landed_cost_uplift', v_uplift);
END $$;

-- 4-way wrapper -----------------------------------------------
CREATE OR REPLACE FUNCTION public.match_bill_with_landed_cost(
  _bill_id uuid, _landed_cost_bill_id uuid, _actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  RETURN public.match_bill_atomic(_bill_id, _actor, _landed_cost_bill_id);
END $$;

-- Governance: SoD additions ----------------------------------
INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('bill.match', 'grn.receive', 'high',
   'Bill matcher must not also be the goods receiver (custody vs verification).'),
  ('bill.match', 'po.approve',  'high',
   'Bill matcher must not also be the PO approver (authorisation vs verification).')
ON CONFLICT DO NOTHING;
