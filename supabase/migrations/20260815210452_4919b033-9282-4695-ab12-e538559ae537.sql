-- ============================================================================
-- Phase 2 — Server authority for Purchases quantities.
-- Every write path derives the canonical base quantity through
-- resolve_line_base_quantity (directly, or via the _uom_normalize_line
-- trigger) and validates policy against THAT number, never against a
-- browser-supplied base quantity.
-- ============================================================================

-- 1. Purchase return lines -----------------------------------------------
-- The returnable-quantity guard previously validated the client's `quantity`
-- while the normalizer re-derived it from display_quantity x pack factor.
-- A line could therefore pass the guard and persist a larger base quantity.
CREATE OR REPLACE FUNCTION public._pret_write_lines(_pr_id uuid, _lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pr public.purchase_returns;
  v_line jsonb; v_idx int := 0;
  v_grn_item public.goods_receipt_items;
  v_qty numeric; v_price numeric; v_tax_rate numeric; v_tax numeric; v_line_total numeric;
  v_returnable numeric;
  v_subtotal numeric := 0; v_tax_total numeric := 0;
  v_product uuid; v_pack uuid; v_duom uuid; v_display numeric;
BEGIN
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = _pr_id;

  DELETE FROM public.purchase_return_items WHERE purchase_return_id = _pr_id;

  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'A purchase return needs at least one line' USING ERRCODE='22023';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_grn_item := NULL;
    IF v_line->>'goods_receipt_item_id' IS NOT NULL THEN
      -- Serialise concurrent returns against the same receipt line.
      PERFORM public._pret_lock_receipt_line((v_line->>'goods_receipt_item_id')::uuid);

      SELECT gi.* INTO v_grn_item
        FROM public.goods_receipt_items gi
        JOIN public.goods_receipts gr ON gr.id = gi.goods_receipt_id
       WHERE gi.id = (v_line->>'goods_receipt_item_id')::uuid
         AND gr.business_id = v_pr.business_id
         AND (v_pr.goods_receipt_id IS NULL OR gi.goods_receipt_id = v_pr.goods_receipt_id);
      IF v_grn_item.id IS NULL THEN
        RAISE EXCEPTION 'Receipt line does not belong to this goods receipt' USING ERRCODE='22023';
      END IF;
    ELSIF v_pr.return_kind = 'goods' THEN
      RAISE EXCEPTION 'A goods return line must reference the goods receipt line it came from'
        USING ERRCODE='22023';
    END IF;

    v_product := COALESCE(v_grn_item.product_id, NULLIF(v_line->>'product_id','')::uuid);
    v_pack    := COALESCE(NULLIF(v_line->>'packaging_id','')::uuid, v_grn_item.packaging_id);
    v_duom    := COALESCE(NULLIF(v_line->>'display_uom_id','')::uuid, v_grn_item.display_uom_id);
    v_display := NULLIF(v_line->>'display_quantity','')::numeric;

    -- Canonical base quantity: derived by the one conversion engine whenever
    -- the caller entered a packaged/alternate-unit quantity. This is the SAME
    -- number `_uom_normalize_line` will persist, so the guard below and the
    -- stored row can never disagree.
    IF v_display IS NOT NULL AND v_product IS NOT NULL THEN
      v_qty := (public.resolve_line_base_quantity(
                  v_pr.business_id, v_product, v_display, v_duom, v_pack
                )->>'base_quantity')::numeric;
    ELSE
      v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    END IF;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Return quantity must be greater than zero' USING ERRCODE='22023';
    END IF;

    IF v_grn_item.id IS NOT NULL THEN
      SELECT quantity_returnable INTO v_returnable
        FROM public.purchase_return_returnable_lines(v_grn_item.goods_receipt_id)
       WHERE goods_receipt_item_id = v_grn_item.id;

      IF v_qty > COALESCE(v_returnable, 0) + 1e-9 THEN
        RAISE EXCEPTION 'Cannot return % of "%": only % remain returnable on this receipt line',
          v_qty, COALESCE(v_grn_item.description,'item'), COALESCE(v_returnable,0)
          USING ERRCODE='22023';
      END IF;
    END IF;

    -- Price basis: receipt landed cost wins; explicit price only for financial adjustments
    v_price := COALESCE(v_grn_item.unit_cost_basis, (v_line->>'unit_price')::numeric, 0);
    v_tax_rate := COALESCE((v_line->>'tax_rate')::numeric, 0);
    v_line_total := ROUND(v_qty * v_price, 6);
    v_tax := ROUND(v_line_total * v_tax_rate / 100.0, 6);

    INSERT INTO public.purchase_return_items(
      purchase_return_id, goods_receipt_item_id, product_id, bill_item_id, description,
      quantity, unit_price, unit_cost_basis, tax_rate, tax_amount, line_total,
      return_reason, condition, lot_number, serial_number, location_id,
      packaging_id, display_quantity, display_uom_id, uom_snapshot, sort_order)
    VALUES (
      _pr_id, v_grn_item.id, v_product,
      NULLIF(v_line->>'bill_item_id','')::uuid,
      COALESCE(NULLIF(v_line->>'description',''), v_grn_item.description, 'Returned item'),
      v_qty, v_price, v_grn_item.unit_cost_basis, v_tax_rate, v_tax, v_line_total,
      NULLIF(v_line->>'return_reason',''), NULLIF(v_line->>'condition',''),
      COALESCE(v_grn_item.lot_number, NULLIF(v_line->>'lot_number','')),
      COALESCE(v_grn_item.serial_number, NULLIF(v_line->>'serial_number','')),
      NULLIF(v_line->>'location_id','')::uuid,
      v_pack, v_display, v_duom,
      COALESCE(v_grn_item.uom_snapshot, NULLIF(v_line->>'uom_snapshot','')),
      v_idx);

    v_subtotal := v_subtotal + v_line_total;
    v_tax_total := v_tax_total + v_tax;
    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.purchase_returns
     SET subtotal = v_subtotal, tax_amount = v_tax_total, total = v_subtotal + v_tax_total,
         updated_at = now()
   WHERE id = _pr_id;

  RETURN jsonb_build_object('subtotal', v_subtotal, 'tax_amount', v_tax_total,
                            'total', v_subtotal + v_tax_total, 'line_count', v_idx);
END
$function$;

-- 2. Goods receipt creation ----------------------------------------------
-- Drop the duplicated base->display division; the normalizer owns it.
CREATE OR REPLACE FUNCTION public.create_goods_receipt(_business_id uuid, _po_id uuid, _lines jsonb, _actor uuid, _warehouse_id uuid DEFAULT NULL::uuid, _receipt_number text DEFAULT NULL::text, _receipt_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gr_id     uuid;
  v_org_id    uuid;
  v_branch_id uuid;
  v_wh_id     uuid := _warehouse_id;
  v_number    text := _receipt_number;
  v_po        RECORD;
  v_line      jsonb;
  v_sort      int := 0;
  v_complete  jsonb;
BEGIN
  IF _business_id IS NULL OR _po_id IS NULL OR _actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'business_id, po_id and actor are required');
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'At least one receipt line is required');
  END IF;

  SELECT id, organization_id, business_id, deliver_to_warehouse_id AS warehouse_id, branch_id, po_number
    INTO v_po FROM public.purchase_orders WHERE id = _po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchase order not found');
  END IF;
  IF v_po.business_id <> _business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'PO does not belong to business');
  END IF;

  v_org_id    := v_po.organization_id;
  v_branch_id := v_po.branch_id;
  v_wh_id     := COALESCE(v_wh_id, v_po.warehouse_id);
  IF v_wh_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No warehouse specified for goods receipt');
  END IF;

  IF v_number IS NULL THEN
    v_number := 'GRN-' || to_char(now(),'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 8);
  END IF;

  INSERT INTO public.goods_receipts (
    organization_id, business_id, branch_id, warehouse_id,
    purchase_order_id, receipt_number, receipt_date, received_by, status
  ) VALUES (
    v_org_id, _business_id, v_branch_id, v_wh_id,
    _po_id, v_number, COALESCE(_receipt_date, CURRENT_DATE), _actor, 'draft'
  )
  RETURNING id INTO v_gr_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_sort := v_sort + 1;
    -- quantity_received / display_quantity are inputs; `_uom_normalize_line`
    -- (trigger a_uom_normalize_grn_items) authors the canonical base quantity
    -- and back-fills whichever of the pair the caller did not send.
    INSERT INTO public.goods_receipt_items (
      goods_receipt_id, purchase_order_item_id, product_id,
      description, quantity_ordered, quantity_received,
      lot_number, serial_number, notes, sort_order, branch_id,
      packaging_id, display_uom_id, display_quantity,
      uom_snapshot, uom_snapshot_pack_name, uom_snapshot_factor, uom_snapshot_base_code
    )
    SELECT
      v_gr_id,
      (v_line->>'purchase_order_item_id')::uuid,
      COALESCE((v_line->>'product_id')::uuid, poi.product_id),
      COALESCE(v_line->>'description', poi.description),
      COALESCE(poi.quantity, 0),
      COALESCE((v_line->>'quantity_received')::numeric, 0),
      NULLIF(v_line->>'lot_number',''),
      NULLIF(v_line->>'serial_number',''),
      NULLIF(v_line->>'notes',''),
      v_sort,
      v_branch_id,
      v_pack.packaging_id,
      COALESCE(NULLIF(v_line->>'display_uom_id','')::uuid, poi.display_uom_id),
      NULLIF(v_line->>'display_quantity','')::numeric,
      poi.uom_snapshot,
      COALESCE(v_pack.pack_name, poi.uom_snapshot_pack_name),
      COALESCE(v_pack.factor, poi.uom_snapshot_factor),
      poi.uom_snapshot_base_code
      FROM public.purchase_order_items poi
      LEFT JOIN LATERAL (
        SELECT pk.id AS packaging_id, pk.name AS pack_name, pk.qty_in_base_uom AS factor
          FROM public.product_packaging pk
         WHERE pk.id = COALESCE(NULLIF(v_line->>'packaging_id','')::uuid, poi.packaging_id)
      ) v_pack ON true
     WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid;
  END LOOP;

  v_complete := public.complete_goods_receipt_atomic(v_gr_id, _actor);
  IF NOT COALESCE((v_complete->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'complete_goods_receipt_atomic failed: %', v_complete->>'error';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'goods_receipt_id', v_gr_id,
    'receipt_number',  v_number,
    'movement_count',  v_complete->'movement_count',
    'journal_id',      v_complete->'journal_id'
  );
END; $function$;

-- 3. Requisition creation (current overload) carries the purchasing unit --
CREATE OR REPLACE FUNCTION public.create_purchase_requisition(p_business_id uuid, p_need_by_date date DEFAULT NULL::date, p_priority text DEFAULT 'normal'::text, p_currency text DEFAULT NULL::text, p_cost_center text DEFAULT NULL::text, p_justification text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_lines jsonb DEFAULT '[]'::jsonb, p_analytic_account_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_destination_branch_id uuid DEFAULT NULL::uuid, p_destination_warehouse_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid; v_req_id uuid; v_req_no text; v_line jsonb; v_sort int := 0; v_ccy text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT organization_id, COALESCE(base_currency, 'USD') INTO v_org, v_ccy
    FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Business not found' USING ERRCODE='22023'; END IF;

  PERFORM public._pr_lifecycle_begin();
  v_req_no := public.get_next_requisition_number(v_org, p_business_id);
  INSERT INTO public.purchase_requisitions(
    organization_id, business_id, requisition_number, requester_id,
    cost_center, analytic_account_id, project_id,
    destination_branch_id, destination_warehouse_id,
    need_by_date, justification, notes, status, priority, currency, estimated_total
  ) VALUES (
    v_org, p_business_id, v_req_no, v_uid,
    p_cost_center, p_analytic_account_id, p_project_id,
    p_destination_branch_id, p_destination_warehouse_id,
    p_need_by_date, p_justification, p_notes,
    'draft', COALESCE(p_priority,'normal'), v_ccy, 0
  ) RETURNING id INTO v_req_id;

  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) > 0 THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_sort := v_sort + 1;
      -- `quantity` is an input; the normalizer authors the base quantity from
      -- display_quantity + packaging_id/display_uom_id when they are supplied.
      INSERT INTO public.purchase_requisition_items(
        requisition_id, product_id, description, uom_id, quantity,
        packaging_id, display_quantity, display_uom_id,
        estimated_unit_price, need_by_date, suggested_supplier_id, contract_line_id,
        destination_branch_id, destination_warehouse_id, status, sort_order, notes
      ) VALUES (
        v_req_id,
        NULLIF(v_line->>'product_id','')::uuid,
        COALESCE(v_line->>'description',''),
        NULLIF(v_line->>'uom_id','')::uuid,
        COALESCE((v_line->>'quantity')::numeric, 0),
        NULLIF(v_line->>'packaging_id','')::uuid,
        NULLIF(v_line->>'display_quantity','')::numeric,
        COALESCE(NULLIF(v_line->>'display_uom_id','')::uuid, NULLIF(v_line->>'uom_id','')::uuid),
        COALESCE((v_line->>'estimated_unit_price')::numeric, 0),
        NULLIF(v_line->>'need_by_date','')::date,
        NULLIF(v_line->>'suggested_supplier_id','')::uuid,
        NULLIF(v_line->>'contract_line_id','')::uuid,
        COALESCE(NULLIF(v_line->>'destination_branch_id','')::uuid, p_destination_branch_id),
        COALESCE(NULLIF(v_line->>'destination_warehouse_id','')::uuid, p_destination_warehouse_id),
        'open', v_sort, NULLIF(v_line->>'notes','')
      );
    END LOOP;
  END IF;
  RETURN v_req_id;
END $function$;

-- 4. Requisition -> RFQ keeps the purchasing unit --------------------------
CREATE OR REPLACE FUNCTION public.requisition_create_rfq(_requisition_id uuid, _line_ids uuid[] DEFAULT NULL::uuid[], _deadline date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_r public.purchase_requisitions; v_uid uuid := auth.uid();
        v_rfq_id uuid; v_rfq_no text; n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Requisition not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_r.status NOT IN ('approved','sourcing','partially_procured') THEN
    RAISE EXCEPTION 'Only an approved requisition can be sourced' USING ERRCODE='22023';
  END IF;

  v_rfq_no := public.get_next_rfq_number(v_r.organization_id);
  INSERT INTO public.rfqs(organization_id, business_id, rfq_number, status, currency,
    branch_id, deliver_to_branch_id, deliver_to_warehouse_id, project_id,
    requisition_id, required_by_date, deadline, created_by, notes)
  VALUES (v_r.organization_id, v_r.business_id, v_rfq_no, 'draft', v_r.currency,
    v_r.branch_id, v_r.destination_branch_id, v_r.destination_warehouse_id, v_r.project_id,
    v_r.id, v_r.need_by_date, _deadline, v_uid,
    'Sourced from requisition ' || v_r.requisition_number)
  RETURNING id INTO v_rfq_id;

  -- Remaining demand is carried in BASE units; packaging/display UoM travel with
  -- it so the supplier is asked in the purchasing unit. display_quantity is left
  -- NULL on purpose: the normalizer derives it from the base quantity + pack.
  INSERT INTO public.rfq_items(rfq_id, product_id, description, quantity, target_price,
                               uom_id, packaging_id, display_uom_id,
                               need_by_date, requisition_item_id, sort_order)
  SELECT v_rfq_id, i.product_id, i.description,
         GREATEST(i.quantity - i.quantity_ordered, 0), NULLIF(i.estimated_unit_price, 0),
         i.uom_id, i.packaging_id, COALESCE(i.display_uom_id, i.uom_id),
         COALESCE(i.need_by_date, v_r.need_by_date), i.id, i.sort_order
    FROM public.purchase_requisition_items i
   WHERE i.requisition_id = _requisition_id
     AND i.status NOT IN ('cancelled','closed')
     AND (_line_ids IS NULL OR i.id = ANY(_line_ids))
     AND GREATEST(i.quantity - i.quantity_ordered, 0) > 0;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'No open requisition lines to source' USING ERRCODE='22023';
  END IF;

  PERFORM public._pr_recalc(_requisition_id);

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.sourced',
          'purchase_requisition', _requisition_id,
          jsonb_build_object('rfq_id', v_rfq_id, 'rfq_number', v_rfq_no, 'lines', n),
          'procurement.requisition.sourced:' || v_rfq_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'rfq_id', v_rfq_id, 'rfq_number', v_rfq_no, 'lines', n);
END $function$;

-- 5. PO -> Bill carries the purchasing unit onto the bill line ------------
CREATE OR REPLACE FUNCTION public.convert_po_to_bill_atomic(_po_id uuid, _user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po RECORD; v_bill_id uuid; v_bill_no text; v_attempts int := 0; v_max int := 20;
  v_company_ccy text; v_rate numeric := 1; v_company_total numeric;
  v_billing text; v_any_under boolean; v_any_billed boolean;
  v_subtotal numeric := 0; v_tax numeric := 0; v_total numeric := 0;
  v_billable int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id, vendor_id, po_number,
         currency, notes, status, billing_status, converted_bill_id
    INTO v_po FROM public.purchase_orders WHERE id = _po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  -- Bill only what has been received and is not yet billed (three-way match).
  DROP TABLE IF EXISTS _billable_lines;
  CREATE TEMP TABLE _billable_lines ON COMMIT DROP AS
  SELECT poi.id AS po_item_id,
         poi.product_id,
         poi.description,
         LEAST(
           GREATEST(COALESCE(poi.quantity_received, 0) - COALESCE(poi.quantity_billed, 0), 0),
           GREATEST(COALESCE(poi.quantity, 0) - COALESCE(poi.quantity_billed, 0), 0)
         ) AS qty,
         COALESCE(poi.unit_price, 0) AS unit_price,
         COALESCE(poi.tax_rate, 0) AS tax_rate,
         COALESCE(poi.sort_order, 0) AS sort_order,
         poi.packaging_id,
         poi.display_uom_id
    FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = v_po.id;

  DELETE FROM _billable_lines WHERE qty <= 0;
  SELECT COUNT(*) INTO v_billable FROM _billable_lines;

  IF v_billable = 0 THEN
    RAISE EXCEPTION
      'Nothing to bill on purchase order %: no received quantity is awaiting an invoice. Receive the goods first.',
      v_po.po_number
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(ROUND(qty * unit_price, 2)), 0),
         COALESCE(SUM(ROUND(qty * unit_price * tax_rate / 100.0, 2)), 0)
    INTO v_subtotal, v_tax FROM _billable_lines;
  v_total := v_subtotal + v_tax;

  SELECT base_currency INTO v_company_ccy FROM public.businesses WHERE id = v_po.business_id;
  IF v_po.currency IS NOT NULL AND v_company_ccy IS NOT NULL AND v_po.currency <> v_company_ccy THEN
    SELECT rate INTO v_rate FROM public.exchange_rates
     WHERE organization_id = v_po.organization_id
       AND from_currency = v_po.currency AND to_currency = v_company_ccy
       AND effective_date <= CURRENT_DATE
     ORDER BY effective_date DESC LIMIT 1;
    v_rate := COALESCE(v_rate, 1);
  END IF;
  v_company_total := ROUND(v_total * v_rate, 2);

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max THEN RAISE EXCEPTION 'Unable to allocate bill number after % attempts', v_max; END IF;
    v_bill_no := public.get_next_bill_number(v_po.organization_id);
    BEGIN
      INSERT INTO public.bills (organization_id, business_id, branch_id, vendor_id,
        bill_number, status, bill_date, due_date, subtotal, tax_amount,
        discount_amount, total, currency, currency_rate, company_currency_total,
        notes, created_by, source_purchase_order_id)
      VALUES (v_po.organization_id, v_po.business_id, v_po.branch_id, v_po.vendor_id,
        v_bill_no, 'draft'::bill_status, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        v_subtotal, v_tax, 0, v_total,
        v_po.currency, v_rate, v_company_total, v_po.notes, _user_id, v_po.id)
      RETURNING id INTO v_bill_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN CONTINUE;
    END;
  END LOOP;

  -- The sync_po_line_billed_quantities trigger recomputes quantity_billed and
  -- PO billing_status from these lines, and blocks any over-billing.
  -- packaging_id / display_uom_id travel with the line so the bill states the
  -- purchasing unit; display_quantity is derived by the normalizer.
  INSERT INTO public.bill_items (bill_id, product_id, purchase_order_item_id,
    description, quantity, unit_price, tax_rate, tax_amount, line_total, sort_order,
    packaging_id, display_uom_id)
  SELECT v_bill_id, l.product_id, l.po_item_id, l.description, l.qty, l.unit_price,
         l.tax_rate,
         ROUND(l.qty * l.unit_price * l.tax_rate / 100.0, 2),
         ROUND(l.qty * l.unit_price, 2),
         l.sort_order,
         l.packaging_id, l.display_uom_id
    FROM _billable_lines l;

  SELECT BOOL_OR(COALESCE(quantity_billed,0) < COALESCE(quantity,0)),
         BOOL_OR(COALESCE(quantity_billed,0) > 0)
    INTO v_any_under, v_any_billed
    FROM public.purchase_order_items WHERE purchase_order_id = v_po.id;

  v_billing := CASE
    WHEN v_any_under IS NOT TRUE THEN 'fully_billed'
    WHEN v_any_billed THEN 'to_bill'
    ELSE 'no'
  END;

  -- converted_bill_id only latches once the PO is fully billed, so a PO can be
  -- billed in instalments as goods arrive.
  UPDATE public.purchase_orders
     SET converted_bill_id = CASE WHEN v_billing = 'fully_billed' THEN v_bill_id ELSE converted_bill_id END,
         billing_status = v_billing,
         updated_at = now()
   WHERE id = v_po.id;

  RETURN jsonb_build_object('success', true, 'bill_id', v_bill_id, 'bill_number', v_bill_no,
    'billing_status', v_billing, 'lines_billed', v_billable,
    'currency_rate', v_rate, 'company_currency_total', v_company_total);
END;
$function$;