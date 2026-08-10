-- =====================================================================
-- Step 3 — one matcher, run automatically, with an exception review path
-- =====================================================================

-- 1. match_bill_atomic absorbs the legacy line-linkage leg
--    (bill_grn_matches), so match_bill_to_grn has nothing left to own.
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
  v_grn RECORD;
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
  v_grn_links integer := 0;
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
    SELECT v_bill.organization_id, v_bill.business_id, _bill_id, 'no_po',
           'Bill has no linked purchase order',
           jsonb_build_object('bill_id', _bill_id), _actor
    WHERE NOT EXISTS (
      SELECT 1 FROM public.bill_match_exceptions x
       WHERE x.bill_id = _bill_id AND x.resolved_at IS NULL AND x.match_state = 'no_po');

    PERFORM public._emit_bill_match_outbox(_bill_id, 'no_po',
      jsonb_build_object('bill_id', _bill_id, 'match_state', 'no_po'));
    RETURN jsonb_build_object('match_state','no_po','result_id',v_result_id,'grn_links',0);
  END IF;

  PERFORM 1 FROM public.purchase_orders WHERE id=v_po_id FOR UPDATE;

  SELECT COALESCE(qty_tolerance_pct,0), COALESCE(price_tolerance_pct,0)
    INTO v_qty_tol, v_price_tol
    FROM public.bill_match_tolerance_policies
   WHERE business_id=v_bill.business_id
     AND effective_from <= now()
     AND (effective_to IS NULL OR effective_to > now())
   ORDER BY effective_from DESC LIMIT 1;
  v_qty_tol := COALESCE(v_qty_tol, 0);
  v_price_tol := COALESCE(v_price_tol, 0);

  IF _landed_cost_bill_id IS NOT NULL THEN
    SELECT COALESCE(total_amount,0) INTO v_lc_total
      FROM public.landed_cost_bills WHERE id=_landed_cost_bill_id;
    SELECT COALESCE(SUM(quantity*unit_price),0) INTO v_po_total
      FROM public.purchase_order_items WHERE purchase_order_id=v_po_id;
    IF v_po_total > 0 THEN v_uplift := v_lc_total / v_po_total; END IF;
  END IF;

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

    -- Line linkage leg (absorbed from the retired match_bill_to_grn):
    -- record which goods-receipt lines back this bill line, with the
    -- unit-cost variance against the PO price. Idempotent.
    FOR v_grn IN
      SELECT gri.id AS gri_id, gri.goods_receipt_id, gri.quantity_received AS gri_qty
        FROM public.goods_receipt_items gri
       WHERE gri.purchase_order_item_id = v_line.po_item_id
    LOOP
      INSERT INTO public.bill_grn_matches (
        organization_id, business_id, bill_id, bill_item_id,
        goods_receipt_id, goods_receipt_item_id,
        matched_quantity, unit_cost_variance, created_by
      ) VALUES (
        v_bill.organization_id, v_bill.business_id, _bill_id, v_line.bill_item_id,
        v_grn.goods_receipt_id, v_grn.gri_id,
        LEAST(COALESCE(v_line.billed_qty,0), COALESCE(v_grn.gri_qty,0)),
        COALESCE(v_line.billed_price,0) - COALESCE(v_line.po_price,0),
        _actor
      )
      ON CONFLICT (bill_item_id, goods_receipt_item_id) DO UPDATE SET
        matched_quantity   = EXCLUDED.matched_quantity,
        unit_cost_variance = EXCLUDED.unit_cost_variance,
        updated_at         = now();
      v_grn_links := v_grn_links + 1;
    END LOOP;

    IF v_line.billed_qty > v_received * (1 + v_qty_tol/100.0) THEN
      v_qty_var := v_qty_var + (v_line.billed_qty - v_received);
      v_worst := 'over_billed';
    ELSIF v_line.billed_qty < v_received * (1 - v_qty_tol/100.0) THEN
      v_qty_var := v_qty_var + (v_line.billed_qty - v_received);
      IF v_worst <> 'over_billed' THEN v_worst := 'under_billed'; END IF;
    END IF;

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
    -- never silently clear a review decision that is already recorded
    exception_state     = CASE
      WHEN EXCLUDED.match_state = 'matched' THEN 'none'::public.bill_match_exception_state
      WHEN public.bill_match_results.exception_state IN ('approved','rejected')
           AND public.bill_match_results.match_state = EXCLUDED.match_state
        THEN public.bill_match_results.exception_state
      ELSE 'pending_review'::public.bill_match_exception_state END,
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
    SELECT v_bill.organization_id, v_bill.business_id, _bill_id, v_worst,
           format('%s variance detected on bill match', v_worst),
           jsonb_build_object(
             'qty_variance', v_qty_var,
             'price_variance', v_price_var,
             'landed_cost_uplift', v_uplift), _actor
    WHERE NOT EXISTS (
      SELECT 1 FROM public.bill_match_exceptions x
       WHERE x.bill_id = _bill_id AND x.resolved_at IS NULL AND x.match_state = v_worst);
  ELSE
    -- clean match supersedes any still-open exception
    UPDATE public.bill_match_exceptions
       SET resolved_at = now(), resolved_by = _actor,
           resolution = COALESCE(resolution, 'auto_resolved_on_clean_match')
     WHERE bill_id = _bill_id AND resolved_at IS NULL;
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
    'landed_cost_uplift', v_uplift,
    'grn_links', v_grn_links);
END $$;

-- 2. Retire the second matcher entirely.
DROP FUNCTION IF EXISTS public.match_bill_to_grn(uuid);

-- 3. Matching runs on submit, so match state exists before anyone approves.
--    A match failure must not block submission; approval is the gate.
CREATE OR REPLACE FUNCTION public.submit_bill_atomic(_bill_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_bill RECORD;
  v_match jsonb := NULL;
BEGIN
  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.status = 'submitted'::bill_status THEN
    RETURN jsonb_build_object('success', true, 'status', 'submitted', 'already', true);
  END IF;
  IF v_bill.status <> 'draft'::bill_status THEN
    RAISE EXCEPTION 'Only draft bills can be submitted for approval (bill % is %)', v_bill.bill_number, v_bill.status;
  END IF;

  UPDATE public.bills
     SET status = 'submitted'::bill_status, updated_at = now()
   WHERE id = _bill_id;

  BEGIN
    v_match := public.match_bill_atomic(_bill_id, COALESCE(_actor, auth.uid()));
  EXCEPTION WHEN OTHERS THEN
    v_match := jsonb_build_object('match_state', 'not_run', 'error', SQLERRM);
  END;

  RETURN jsonb_build_object('success', true, 'status', 'submitted',
                            'bill_number', v_bill.bill_number,
                            'match', v_match);
END;
$function$;

-- 4. Exception review path: a reviewer accepts or rejects the variance.
CREATE OR REPLACE FUNCTION public.resolve_bill_match_exception_atomic(
  _bill_id uuid,
  _decision text,
  _note text DEFAULT NULL,
  _actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := COALESCE(_actor, auth.uid());
  v_res RECORD;
  v_new public.bill_match_exception_state;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor is required'; END IF;
  IF _decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected (got %)', _decision;
  END IF;
  v_new := _decision::public.bill_match_exception_state;

  SELECT * INTO v_res FROM public.bill_match_results WHERE bill_id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill % has no match result to review', _bill_id; END IF;
  IF NOT public.user_has_business_access(v_actor, v_res.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF v_res.exception_state = 'none' THEN
    RETURN jsonb_build_object('success', true, 'exception_state', 'none', 'noop', true);
  END IF;
  IF v_res.matched_by = v_actor THEN
    RAISE EXCEPTION 'SoD violation: the actor who ran the match cannot review its exception'
      USING ERRCODE='42501';
  END IF;

  UPDATE public.bill_match_results
     SET exception_state = v_new, updated_at = now()
   WHERE bill_id = _bill_id;

  UPDATE public.bill_match_exceptions
     SET resolved_at = now(), resolved_by = v_actor,
         resolution = _decision || COALESCE(': ' || _note, '')
   WHERE bill_id = _bill_id AND resolved_at IS NULL;

  PERFORM public._emit_bill_match_outbox(_bill_id, 'reviewed', jsonb_build_object(
    'bill_id', _bill_id, 'decision', _decision, 'note', _note, 'actor', v_actor));

  RETURN jsonb_build_object('success', true, 'exception_state', v_new);
END $$;

REVOKE ALL ON FUNCTION public.resolve_bill_match_exception_atomic(uuid, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_bill_match_exception_atomic(uuid, text, text, uuid) TO authenticated;