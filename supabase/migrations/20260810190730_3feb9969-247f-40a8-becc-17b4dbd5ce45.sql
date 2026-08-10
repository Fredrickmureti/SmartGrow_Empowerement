-- ============================================================
-- RFQ / Sourcing domain — Phase 2: server-side lifecycle
-- ============================================================

CREATE OR REPLACE FUNCTION public._rfq_emit(_rfq public.rfqs, _event text, _payload jsonb, _actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO business_event_outbox (organization_id, business_id, event_type, aggregate_type,
    aggregate_id, payload, idempotency_key, status, created_at)
  VALUES (_rfq.organization_id, _rfq.business_id, _event, 'rfq', _rfq.id,
    COALESCE(_payload, '{}'::jsonb) || jsonb_build_object('rfq_number', _rfq.rfq_number, 'actor', _actor),
    _event || ':' || _rfq.id::text || ':' || _rfq.version::text, 'pending', now())
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN others THEN
  NULL; -- outbox shape drift must never break the lifecycle transaction
END;
$$;

CREATE OR REPLACE FUNCTION public._rfq_guard(_rfq_id uuid, _allowed text[])
RETURNS public.rfqs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.rfqs;
BEGIN
  SELECT * INTO v FROM rfqs WHERE id = _rfq_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RFQ not found'; END IF;
  IF NOT user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business';
  END IF;
  IF _allowed IS NOT NULL AND NOT (v.status = ANY(_allowed)) THEN
    RAISE EXCEPTION 'RFQ % is % — expected one of %', v.rfq_number, v.status, array_to_string(_allowed, ', ');
  END IF;
  RETURN v;
END;
$$;

-- ---------- submit / approve ----------
CREATE OR REPLACE FUNCTION public.rfq_submit_for_approval(_rfq_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.rfqs; n int;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['draft']);
  SELECT count(*) INTO n FROM rfq_items WHERE rfq_id = _rfq_id;
  IF n = 0 THEN RAISE EXCEPTION 'An RFQ needs at least one line'; END IF;
  SELECT count(*) INTO n FROM rfq_invitations WHERE rfq_id = _rfq_id AND rfq_version = v.version;
  IF n = 0 THEN RAISE EXCEPTION 'Invite at least one supplier before submitting'; END IF;

  UPDATE rfqs SET status = 'pending_approval', submitted_by = auth.uid(),
    submitted_at = now(), updated_at = now() WHERE id = _rfq_id;
  PERFORM _rfq_emit(v, 'rfq.submitted', '{}'::jsonb, auth.uid());
  RETURN jsonb_build_object('success', true, 'status', 'pending_approval');
END;
$$;

CREATE OR REPLACE FUNCTION public.rfq_approve(_rfq_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.rfqs;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['pending_approval']);
  IF v.submitted_by = auth.uid() THEN
    RAISE EXCEPTION 'Segregation of duties: an RFQ cannot be approved by the user who submitted it';
  END IF;
  UPDATE rfqs SET status = 'approved', approved_by = auth.uid(), approved_at = now(),
    updated_at = now() WHERE id = _rfq_id;
  PERFORM _rfq_emit(v, 'rfq.approved', '{}'::jsonb, auth.uid());
  RETURN jsonb_build_object('success', true, 'status', 'approved');
END;
$$;

-- ---------- release (request supplier invitations) ----------
CREATE OR REPLACE FUNCTION public.rfq_release(_rfq_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.rfqs; v_deadline timestamptz; n int;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['approved','sent']);
  v_deadline := COALESCE(v.expires_at, (v.deadline::timestamptz + interval '1 day' - interval '1 second'));

  UPDATE rfq_invitations SET invitation_state = 'invited', delivery_state = 'queued',
      requested_at = COALESCE(requested_at, now()), response_deadline = v_deadline, updated_at = now()
    WHERE rfq_id = _rfq_id AND rfq_version = v.version AND invitation_state = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE rfqs SET status = 'sent', released_by = COALESCE(released_by, auth.uid()),
    released_at = COALESCE(released_at, now()), expires_at = v_deadline, updated_at = now()
   WHERE id = _rfq_id;

  PERFORM _rfq_emit(v, 'rfq.supplier_invitation_requested',
    jsonb_build_object('invitations', n, 'deadline', v_deadline), auth.uid());
  RETURN jsonb_build_object('success', true, 'invitations_requested', n);
END;
$$;

-- ---------- supplier quotation ----------
CREATE OR REPLACE FUNCTION public.rfq_record_quotation(
  _invitation_id uuid, _header jsonb, _lines jsonb, _allow_late boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v public.rfqs; inv public.rfq_invitations; prev public.rfq_quotations;
  v_is_portal boolean; v_q_id uuid; v_version int; v_late boolean := false;
  v_sub numeric := 0; v_tax numeric := 0; v_freight numeric;
BEGIN
  SELECT * INTO inv FROM rfq_invitations WHERE id = _invitation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found'; END IF;
  SELECT * INTO v FROM rfqs WHERE id = inv.rfq_id FOR UPDATE;

  v_is_portal := EXISTS (SELECT 1 FROM contacts c WHERE c.id = inv.supplier_id AND c.portal_user_id = auth.uid());
  IF NOT v_is_portal AND NOT user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Not authorised to quote on this RFQ';
  END IF;
  IF inv.rfq_version <> v.version THEN
    RAISE EXCEPTION 'This RFQ has been revised — the invitation is out of date';
  END IF;
  IF v.status NOT IN ('sent','responses_received','under_evaluation') THEN
    RAISE EXCEPTION 'RFQ % is not open for quotations (%)', v.rfq_number, v.status;
  END IF;
  IF inv.invitation_state IN ('withdrawn','superseded') THEN
    RAISE EXCEPTION 'This invitation is no longer active';
  END IF;

  IF inv.response_deadline IS NOT NULL AND now() > inv.response_deadline THEN
    IF v_is_portal AND NOT _allow_late THEN
      RAISE EXCEPTION 'The response deadline for RFQ % has passed', v.rfq_number;
    END IF;
    v_late := true;
  END IF;

  SELECT * INTO prev FROM rfq_quotations
   WHERE invitation_id = _invitation_id AND state = 'submitted' FOR UPDATE;
  v_version := COALESCE(prev.quotation_version, 0) + 1;
  v_freight := COALESCE((_header->>'freight_amount')::numeric, 0);

  INSERT INTO rfq_quotations (rfq_id, invitation_id, supplier_id, rfq_version, quotation_version,
    state, supplier_reference, currency, subtotal, tax_total, freight_amount, total,
    lead_time_days, incoterms, payment_terms, valid_until, notes,
    submitted_by, submitted_via, is_late)
  VALUES (v.id, inv.id, inv.supplier_id, v.version, v_version, 'submitted',
    _header->>'supplier_reference',
    COALESCE(NULLIF(_header->>'currency',''), v.currency, 'USD'),
    0, 0, v_freight, 0,
    NULLIF(_header->>'lead_time_days','')::int, _header->>'incoterms', _header->>'payment_terms',
    NULLIF(_header->>'valid_until','')::date, _header->>'notes',
    auth.uid(), CASE WHEN v_is_portal THEN 'portal' ELSE 'internal' END, v_late)
  RETURNING id INTO v_q_id;

  INSERT INTO rfq_quotation_items (quotation_id, rfq_item_id, product_id, alternate_product_id,
    is_alternate, supplier_product_code, description, quoted_quantity, quoted_uom_id,
    unit_price, discount_percent, tax_rate, tax_amount, line_total, lead_time_days,
    delivery_date, notes, sort_order)
  SELECT v_q_id, ri.id, ri.product_id,
    NULLIF(l->>'alternate_product_id','')::uuid,
    COALESCE((l->>'is_alternate')::boolean, false),
    l->>'supplier_product_code', COALESCE(l->>'description', ri.description),
    COALESCE((l->>'quoted_quantity')::numeric, ri.quantity),
    COALESCE(NULLIF(l->>'quoted_uom_id','')::uuid, ri.uom_id),
    COALESCE((l->>'unit_price')::numeric, 0),
    COALESCE((l->>'discount_percent')::numeric, 0),
    COALESCE((l->>'tax_rate')::numeric, 0),
    ROUND(COALESCE((l->>'quoted_quantity')::numeric, ri.quantity)
        * COALESCE((l->>'unit_price')::numeric, 0)
        * (1 - COALESCE((l->>'discount_percent')::numeric, 0) / 100)
        * COALESCE((l->>'tax_rate')::numeric, 0) / 100, 6),
    ROUND(COALESCE((l->>'quoted_quantity')::numeric, ri.quantity)
        * COALESCE((l->>'unit_price')::numeric, 0)
        * (1 - COALESCE((l->>'discount_percent')::numeric, 0) / 100), 6),
    NULLIF(l->>'lead_time_days','')::int, NULLIF(l->>'delivery_date','')::date,
    l->>'notes', COALESCE(ri.sort_order, 0)
  FROM jsonb_array_elements(COALESCE(_lines, '[]'::jsonb)) l
  JOIN rfq_items ri ON ri.id = (l->>'rfq_item_id')::uuid AND ri.rfq_id = v.id;

  SELECT COALESCE(SUM(line_total),0), COALESCE(SUM(tax_amount),0)
    INTO v_sub, v_tax FROM rfq_quotation_items WHERE quotation_id = v_q_id;
  UPDATE rfq_quotations SET subtotal = v_sub, tax_total = v_tax,
    total = v_sub + v_tax + v_freight WHERE id = v_q_id;

  IF prev.id IS NOT NULL THEN
    UPDATE rfq_quotations SET state = 'superseded', superseded_by = v_q_id WHERE id = prev.id;
  END IF;

  UPDATE rfq_invitations SET invitation_state = 'quoted', updated_at = now() WHERE id = inv.id;
  UPDATE rfqs SET status = CASE WHEN status = 'sent' THEN 'responses_received' ELSE status END,
    updated_at = now() WHERE id = v.id;

  PERFORM _rfq_emit(v, CASE WHEN prev.id IS NULL THEN 'rfq.quotation_received' ELSE 'rfq.quotation_revised' END,
    jsonb_build_object('quotation_id', v_q_id, 'supplier_id', inv.supplier_id, 'total', v_sub + v_tax + v_freight), auth.uid());

  RETURN jsonb_build_object('success', true, 'quotation_id', v_q_id, 'version', v_version, 'is_late', v_late);
END;
$$;

CREATE OR REPLACE FUNCTION public.rfq_withdraw_quotation(_quotation_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE q public.rfq_quotations; v public.rfqs;
BEGIN
  SELECT * INTO q FROM rfq_quotations WHERE id = _quotation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found'; END IF;
  SELECT * INTO v FROM rfqs WHERE id = q.rfq_id;
  IF NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = q.supplier_id AND c.portal_user_id = auth.uid())
     AND NOT user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF q.state <> 'submitted' THEN RAISE EXCEPTION 'Only an active quotation can be withdrawn'; END IF;
  IF EXISTS (SELECT 1 FROM rfq_awards a WHERE a.quotation_id = q.id) THEN
    RAISE EXCEPTION 'This quotation has been awarded and cannot be withdrawn';
  END IF;

  UPDATE rfq_quotations SET state = 'withdrawn', withdrawn_at = now() WHERE id = q.id;
  UPDATE rfq_invitations SET invitation_state = 'withdrawn', updated_at = now(),
    decline_reason = _reason WHERE id = q.invitation_id;
  PERFORM _rfq_emit(v, 'rfq.quotation_withdrawn',
    jsonb_build_object('quotation_id', q.id, 'supplier_id', q.supplier_id), auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ---------- revision ----------
CREATE OR REPLACE FUNCTION public.rfq_revise(_rfq_id uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.rfqs; v_next int;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['approved','sent','responses_received','under_evaluation']);
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A revision reason is required';
  END IF;
  v_next := v.version + 1;

  INSERT INTO rfq_revisions (rfq_id, version, reason, snapshot, revised_by)
  VALUES (_rfq_id, v.version, _reason,
    jsonb_build_object(
      'rfq', to_jsonb(v),
      'items', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM rfq_items i WHERE i.rfq_id = _rfq_id), '[]'::jsonb),
      'invitations', COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM rfq_invitations x
                               WHERE x.rfq_id = _rfq_id AND x.rfq_version = v.version), '[]'::jsonb)),
    auth.uid());

  UPDATE rfq_quotations SET state = 'superseded'
   WHERE rfq_id = _rfq_id AND state = 'submitted';

  INSERT INTO rfq_invitations (rfq_id, rfq_version, supplier_id, contact_email, channel,
    invitation_state, delivery_state, response_deadline, created_by)
  SELECT _rfq_id, v_next, supplier_id, contact_email, channel, 'pending', 'not_sent',
    response_deadline, auth.uid()
    FROM rfq_invitations WHERE rfq_id = _rfq_id AND rfq_version = v.version
  ON CONFLICT DO NOTHING;

  UPDATE rfq_invitations SET invitation_state = 'superseded', updated_at = now()
   WHERE rfq_id = _rfq_id AND rfq_version = v.version;

  UPDATE rfqs SET version = v_next, status = 'approved', updated_at = now() WHERE id = _rfq_id;

  PERFORM _rfq_emit(v, 'rfq.revised', jsonb_build_object('new_version', v_next, 'reason', _reason), auth.uid());
  RETURN jsonb_build_object('success', true, 'version', v_next);
END;
$$;

-- ---------- award (supports split / partial) ----------
CREATE OR REPLACE FUNCTION public.rfq_award(_rfq_id uuid, _awards jsonb, _justification text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v public.rfqs; a jsonb; l jsonb; q public.rfq_quotations;
  v_award_id uuid; v_total numeric; v_awarded_lines int := 0; v_demand int; v_covered int;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['responses_received','under_evaluation','sent']);
  IF _justification IS NULL OR btrim(_justification) = '' THEN
    RAISE EXCEPTION 'An award justification is required';
  END IF;
  IF jsonb_array_length(COALESCE(_awards,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Nothing to award';
  END IF;
  IF EXISTS (SELECT 1 FROM rfq_awards WHERE rfq_id = _rfq_id) THEN
    RAISE EXCEPTION 'RFQ % has already been awarded', v.rfq_number;
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(_awards) LOOP
    SELECT * INTO q FROM rfq_quotations
     WHERE id = (a->>'quotation_id')::uuid AND rfq_id = _rfq_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found on this RFQ'; END IF;
    IF q.state <> 'submitted' THEN RAISE EXCEPTION 'Quotation is % and cannot be awarded', q.state; END IF;

    INSERT INTO rfq_awards (rfq_id, supplier_id, quotation_id, currency, award_reason, awarded_by)
    VALUES (_rfq_id, q.supplier_id, q.id, q.currency, a->>'reason', auth.uid())
    RETURNING id INTO v_award_id;

    FOR l IN SELECT * FROM jsonb_array_elements(a->'lines') LOOP
      INSERT INTO rfq_award_items (award_id, rfq_item_id, quotation_item_id, awarded_quantity,
        awarded_uom_id, unit_price, tax_rate, line_total)
      SELECT v_award_id, qi.rfq_item_id, qi.id,
        (l->>'awarded_quantity')::numeric, qi.quoted_uom_id, qi.unit_price, qi.tax_rate,
        ROUND((l->>'awarded_quantity')::numeric * qi.unit_price, 6)
      FROM rfq_quotation_items qi
      WHERE qi.id = (l->>'quotation_item_id')::uuid AND qi.quotation_id = q.id
        AND (l->>'awarded_quantity')::numeric > 0
        AND (l->>'awarded_quantity')::numeric <= qi.quoted_quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Awarded quantity exceeds the quantity quoted, or the line does not belong to this quotation';
      END IF;
      v_awarded_lines := v_awarded_lines + 1;
    END LOOP;

    SELECT COALESCE(SUM(line_total),0) INTO v_total FROM rfq_award_items WHERE award_id = v_award_id;
    UPDATE rfq_awards SET awarded_value = v_total WHERE id = v_award_id;
    UPDATE rfq_quotations SET state = 'awarded' WHERE id = q.id;
  END LOOP;

  UPDATE rfq_quotations SET state = 'rejected'
   WHERE rfq_id = _rfq_id AND state = 'submitted';

  SELECT count(*) INTO v_demand FROM rfq_items WHERE rfq_id = _rfq_id;
  SELECT count(DISTINCT ai.rfq_item_id) INTO v_covered
    FROM rfq_award_items ai JOIN rfq_awards aw ON aw.id = ai.award_id WHERE aw.rfq_id = _rfq_id;

  UPDATE rfqs SET status = CASE WHEN v_covered >= v_demand THEN 'awarded' ELSE 'partially_awarded' END,
    awarded_by = auth.uid(), awarded_at = now(), award_justification = _justification,
    updated_at = now() WHERE id = _rfq_id;

  PERFORM _rfq_emit(v, 'rfq.awarded',
    jsonb_build_object('lines', v_awarded_lines, 'suppliers', jsonb_array_length(_awards)), auth.uid());

  RETURN jsonb_build_object('success', true, 'awarded_lines', v_awarded_lines,
    'fully_awarded', v_covered >= v_demand);
END;
$$;

-- ---------- conversion to purchase orders ----------
CREATE OR REPLACE FUNCTION public.rfq_convert_awards_to_po(_rfq_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v public.rfqs; aw RECORD; q public.rfq_quotations;
  v_po_id uuid; v_po_no text; v_sub numeric; v_tax numeric; v_lead int;
  v_pos jsonb := '[]'::jsonb;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['awarded','partially_awarded']);

  FOR aw IN SELECT * FROM rfq_awards WHERE rfq_id = _rfq_id FOR UPDATE LOOP
    IF aw.purchase_order_id IS NOT NULL THEN CONTINUE; END IF;  -- idempotent
    SELECT * INTO q FROM rfq_quotations WHERE id = aw.quotation_id;

    SELECT COALESCE(SUM(line_total),0), COALESCE(SUM(line_total * tax_rate / 100),0)
      INTO v_sub, v_tax FROM rfq_award_items WHERE award_id = aw.id;
    v_lead := COALESCE(q.lead_time_days, 0);
    v_po_no := get_next_po_number(v.organization_id);

    INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number,
      status, order_date, expected_date, subtotal, tax_amount, discount_amount, total, currency,
      notes, created_by, project_id, requisition_id, deliver_to_warehouse_id, deliver_to_branch_id,
      rfq_id, rfq_award_id)
    VALUES (v.organization_id, v.business_id, v.branch_id, aw.supplier_id, v_po_no,
      'draft', CURRENT_DATE, CURRENT_DATE + (v_lead || ' days')::interval,
      v_sub, v_tax, 0, v_sub + v_tax, aw.currency,
      v.notes, auth.uid(), v.project_id, v.requisition_id, v.deliver_to_warehouse_id,
      COALESCE(v.deliver_to_branch_id, v.branch_id), v.id, aw.id)
    RETURNING id INTO v_po_id;

    INSERT INTO purchase_order_items (purchase_order_id, product_id, description, quantity,
      quantity_received, unit_price, tax_rate, tax_amount, line_total, sort_order,
      display_uom_id, display_quantity, requisition_item_id, rfq_item_id, rfq_quotation_item_id)
    SELECT v_po_id, COALESCE(qi.alternate_product_id, qi.product_id, ri.product_id),
      COALESCE(qi.description, ri.description), ai.awarded_quantity, 0, ai.unit_price,
      ai.tax_rate, ROUND(ai.line_total * ai.tax_rate / 100, 6), ai.line_total,
      COALESCE(ri.sort_order, 0), ai.awarded_uom_id, ai.awarded_quantity,
      ri.requisition_item_id, ri.id, qi.id
    FROM rfq_award_items ai
    JOIN rfq_items ri ON ri.id = ai.rfq_item_id
    JOIN rfq_quotation_items qi ON qi.id = ai.quotation_item_id
    WHERE ai.award_id = aw.id;

    UPDATE rfq_awards SET purchase_order_id = v_po_id, converted_at = now() WHERE id = aw.id;
    v_pos := v_pos || jsonb_build_object('purchase_order_id', v_po_id, 'po_number', v_po_no,
                                         'supplier_id', aw.supplier_id);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM rfq_awards WHERE rfq_id = _rfq_id AND purchase_order_id IS NULL) THEN
    UPDATE rfqs SET status = 'converted', converted_at = now(), closed_at = now(),
      closed_by = auth.uid(), updated_at = now() WHERE id = _rfq_id;
  END IF;

  PERFORM _rfq_emit(v, 'rfq.converted_to_purchase_order', jsonb_build_object('purchase_orders', v_pos), auth.uid());
  RETURN jsonb_build_object('success', true, 'purchase_orders', v_pos);
END;
$$;

-- ---------- cancel / expire ----------
CREATE OR REPLACE FUNCTION public.rfq_cancel(_rfq_id uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.rfqs;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['draft','pending_approval','approved','sent','responses_received','under_evaluation','expired']);
  IF EXISTS (SELECT 1 FROM rfq_awards WHERE rfq_id = _rfq_id AND purchase_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This RFQ already produced a purchase order and cannot be cancelled';
  END IF;
  UPDATE rfq_quotations SET state = 'rejected' WHERE rfq_id = _rfq_id AND state = 'submitted';
  UPDATE rfqs SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
    cancelled_reason = _reason, updated_at = now() WHERE id = _rfq_id;
  PERFORM _rfq_emit(v, 'rfq.cancelled', jsonb_build_object('reason', _reason), auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rfq_expire_due(_business_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n int;
BEGIN
  IF NOT user_can_access_business(auth.uid(), _business_id) THEN RETURN 0; END IF;
  UPDATE rfqs SET status = 'expired', updated_at = now()
   WHERE business_id = _business_id
     AND status IN ('sent','responses_received','under_evaluation')
     AND expires_at IS NOT NULL AND expires_at < now()
     AND NOT EXISTS (SELECT 1 FROM rfq_awards a WHERE a.rfq_id = rfqs.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------- retire the superseded single-supplier RPCs ----------
DROP FUNCTION IF EXISTS public.award_rfq_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.convert_rfq_to_po_atomic(uuid, uuid, uuid);

GRANT EXECUTE ON FUNCTION public.rfq_submit_for_approval(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_release(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_record_quotation(uuid, jsonb, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_withdraw_quotation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_revise(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_award(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_convert_awards_to_po(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_cancel(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_expire_due(uuid) TO authenticated;