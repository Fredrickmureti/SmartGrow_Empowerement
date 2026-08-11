-- =====================================================================
-- Purchase Returns — Phases 3-7
-- Server-authoritative lifecycle, governance, inventory, finance, events
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Lifecycle flag + guards
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pret_lifecycle_begin()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN PERFORM set_config('app.pret_lifecycle','on',true); END $$;

CREATE OR REPLACE FUNCTION public._purchase_return_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  -- SECURITY DEFINER lifecycle functions run as the function owner and are
  -- always allowed. Direct client DML (role `authenticated`) is refused.
  IF current_user = 'authenticated'
     AND COALESCE(current_setting('app.pret_lifecycle', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'Purchase returns are server-owned: use the purchase_return_* commands'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS pret_guard_header ON public.purchase_returns;
CREATE TRIGGER pret_guard_header
  BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public._purchase_return_guard();

DROP TRIGGER IF EXISTS pret_guard_item ON public.purchase_return_items;
CREATE TRIGGER pret_guard_item
  BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_return_items
  FOR EACH ROW EXECUTE FUNCTION public._purchase_return_guard();

REVOKE INSERT, UPDATE, DELETE ON public.purchase_returns FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.purchase_return_items FROM authenticated;
GRANT SELECT ON public.purchase_returns TO authenticated;
GRANT SELECT ON public.purchase_return_items TO authenticated;
GRANT ALL ON public.purchase_returns TO service_role;
GRANT ALL ON public.purchase_return_items TO service_role;

-- Server-side number assignment (also repairs warehouse-raised returns)
CREATE OR REPLACE FUNCTION public._purchase_return_assign_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.return_number IS NULL
     OR NEW.return_number = ''
     OR NEW.return_number ~ '^PR-\d{6}-' THEN
    NEW.return_number := public.get_next_purchase_return_number(NEW.organization_id, NEW.business_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pret_assign_number ON public.purchase_returns;
CREATE TRIGGER pret_assign_number
  BEFORE INSERT ON public.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public._purchase_return_assign_number();

-- ---------------------------------------------------------------------
-- 1. Returnable quantity (canonical invariant source)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_return_returnable_lines(_goods_receipt_id uuid)
RETURNS TABLE (
  goods_receipt_item_id uuid,
  product_id uuid,
  description text,
  lot_number text,
  serial_number text,
  quantity_received numeric,
  quantity_returned numeric,
  quantity_returnable numeric,
  unit_cost numeric,
  packaging_id uuid,
  display_uom_id uuid,
  uom_snapshot text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT gi.id,
         gi.product_id,
         COALESCE(gi.description::text, p.name::text, 'Received item'),
         gi.lot_number::text,
         gi.serial_number::text,
         COALESCE(gi.quantity_received::numeric, 0),
         COALESCE(ret.qty::numeric, 0),
         GREATEST(COALESCE(gi.quantity_received::numeric, 0) - COALESCE(ret.qty::numeric, 0), 0::numeric),
         COALESCE(gi.unit_cost_basis::numeric, 0),
         gi.packaging_id,
         gi.display_uom_id,
         gi.uom_snapshot::text
    FROM public.goods_receipt_items gi
    JOIN public.goods_receipts gr ON gr.id = gi.goods_receipt_id
    LEFT JOIN public.products p ON p.id = gi.product_id
    LEFT JOIN LATERAL (
      SELECT SUM(ri.quantity) AS qty
        FROM public.purchase_return_items ri
        JOIN public.purchase_returns r ON r.id = ri.purchase_return_id
       WHERE ri.goods_receipt_item_id = gi.id
         AND r.status NOT IN ('rejected','cancelled')
    ) ret ON TRUE
   WHERE gi.goods_receipt_id = _goods_receipt_id
     AND public.user_can_access_business(auth.uid(), gr.business_id)
   ORDER BY gi.sort_order NULLS LAST, gi.created_at;
$$;

REVOKE ALL ON FUNCTION public.purchase_return_returnable_lines(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.purchase_return_returnable_lines(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Shared internals
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pret_log(
  _pr public.purchase_returns, _event text, _from text, _to text, _detail jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.purchase_return_events(
    organization_id, business_id, purchase_return_id, event_type, from_status, to_status,
    actor_user_id, approval_request_id, vendor_credit_note_id, detail)
  VALUES (_pr.organization_id, _pr.business_id, _pr.id, _event, _from, _to,
          auth.uid(), _pr.approval_request_id, _pr.vendor_credit_note_id, COALESCE(_detail,'{}'::jsonb));

  INSERT INTO public.business_event_outbox
    (org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, actor_user_id, source)
  VALUES (_pr.organization_id, _pr.branch_id, 'purchasing.purchase_return.' || _event,
          'purchase_return', _pr.id,
          jsonb_build_object('status', _to, 'return_number', _pr.return_number,
                             'vendor_id', _pr.vendor_id, 'total', _pr.total) || COALESCE(_detail,'{}'::jsonb),
          'purchasing.purchase_return.' || _event || ':' || _pr.id::text || ':v' || _pr.row_version::text,
          auth.uid(), 'purchasing')
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public._pret_load(_id uuid, _row_version integer)
RETURNS public.purchase_returns LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v public.purchase_returns;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.purchase_returns WHERE id = _id FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Purchase return not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF _row_version IS NOT NULL AND v.row_version <> _row_version THEN
    RAISE EXCEPTION 'This return changed since it was loaded (version % <> %)', v.row_version, _row_version
      USING ERRCODE='40001';
  END IF;
  RETURN v;
END $$;

-- Validate + write lines for a draft return; returns totals.
CREATE OR REPLACE FUNCTION public._pret_write_lines(_pr_id uuid, _lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_pr public.purchase_returns;
  v_line jsonb; v_idx int := 0;
  v_grn_item public.goods_receipt_items;
  v_qty numeric; v_price numeric; v_tax_rate numeric; v_tax numeric; v_line_total numeric;
  v_returnable numeric;
  v_subtotal numeric := 0; v_tax_total numeric := 0;
BEGIN
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = _pr_id;

  DELETE FROM public.purchase_return_items WHERE purchase_return_id = _pr_id;

  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'A purchase return needs at least one line' USING ERRCODE='22023';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Return quantity must be greater than zero' USING ERRCODE='22023'; END IF;

    v_grn_item := NULL;
    IF v_line->>'goods_receipt_item_id' IS NOT NULL THEN
      SELECT gi.* INTO v_grn_item
        FROM public.goods_receipt_items gi
        JOIN public.goods_receipts gr ON gr.id = gi.goods_receipt_id
       WHERE gi.id = (v_line->>'goods_receipt_item_id')::uuid
         AND gr.business_id = v_pr.business_id
         AND (v_pr.goods_receipt_id IS NULL OR gi.goods_receipt_id = v_pr.goods_receipt_id);
      IF v_grn_item.id IS NULL THEN
        RAISE EXCEPTION 'Receipt line does not belong to this goods receipt' USING ERRCODE='22023';
      END IF;

      SELECT quantity_returnable INTO v_returnable
        FROM public.purchase_return_returnable_lines(v_grn_item.goods_receipt_id)
       WHERE goods_receipt_item_id = v_grn_item.id;

      IF v_qty > COALESCE(v_returnable, 0) + 1e-9 THEN
        RAISE EXCEPTION 'Cannot return % of "%": only % remain returnable on this receipt line',
          v_qty, COALESCE(v_grn_item.description,'item'), COALESCE(v_returnable,0)
          USING ERRCODE='22023';
      END IF;
    ELSIF v_pr.return_kind = 'goods' THEN
      RAISE EXCEPTION 'A goods return line must reference the goods receipt line it came from'
        USING ERRCODE='22023';
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
      _pr_id, v_grn_item.id,
      COALESCE(v_grn_item.product_id, NULLIF(v_line->>'product_id','')::uuid),
      NULLIF(v_line->>'bill_item_id','')::uuid,
      COALESCE(NULLIF(v_line->>'description',''), v_grn_item.description, 'Returned item'),
      v_qty, v_price, v_grn_item.unit_cost_basis, v_tax_rate, v_tax, v_line_total,
      NULLIF(v_line->>'return_reason',''), NULLIF(v_line->>'condition',''),
      COALESCE(v_grn_item.lot_number, NULLIF(v_line->>'lot_number','')),
      COALESCE(v_grn_item.serial_number, NULLIF(v_line->>'serial_number','')),
      NULLIF(v_line->>'location_id','')::uuid,
      COALESCE(v_grn_item.packaging_id, NULLIF(v_line->>'packaging_id','')::uuid),
      NULLIF(v_line->>'display_quantity','')::numeric,
      COALESCE(v_grn_item.display_uom_id, NULLIF(v_line->>'display_uom_id','')::uuid),
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
END $$;

-- ---------------------------------------------------------------------
-- 3. Lifecycle commands
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_return_create(
  _business_id uuid,
  _vendor_id uuid,
  _lines jsonb,
  _return_kind text DEFAULT 'goods',
  _goods_receipt_id uuid DEFAULT NULL,
  _bill_id uuid DEFAULT NULL,
  _warehouse_id uuid DEFAULT NULL,
  _return_date date DEFAULT NULL,
  _reason_code text DEFAULT NULL,
  _reason text DEFAULT NULL,
  _notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid; v_branch uuid; v_grn public.goods_receipts;
  v_currency text; v_rate numeric := 1; v_base text;
  v_id uuid; v_pr public.purchase_returns; v_totals jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_can_access_business(v_uid, _business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF _return_kind NOT IN ('goods','financial') THEN
    RAISE EXCEPTION 'Unknown return kind %', _return_kind USING ERRCODE='22023';
  END IF;

  SELECT organization_id, base_currency INTO v_org, v_base FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Business not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_has_module_permission(v_uid, v_org, _business_id, 'purchases', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to create purchase returns' USING ERRCODE='42501';
  END IF;

  IF _goods_receipt_id IS NOT NULL THEN
    SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _goods_receipt_id;
    IF v_grn.id IS NULL OR v_grn.business_id <> _business_id THEN
      RAISE EXCEPTION 'Goods receipt not found for this company' USING ERRCODE='22023';
    END IF;
    v_branch := v_grn.branch_id;
  ELSIF _return_kind = 'goods' THEN
    RAISE EXCEPTION 'A goods return must originate from a goods receipt' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(b.currency, po.currency, v_base, 'USD')
    INTO v_currency
    FROM (SELECT 1) x
    LEFT JOIN public.bills b ON b.id = _bill_id
    LEFT JOIN public.purchase_orders po ON po.id = v_grn.purchase_order_id;
  v_currency := COALESCE(v_currency, v_base, 'USD');

  IF v_currency IS DISTINCT FROM v_base THEN
    SELECT rate INTO v_rate FROM public.exchange_rates
     WHERE organization_id = v_org AND from_currency = v_currency AND to_currency = v_base
       AND effective_date <= COALESCE(_return_date, CURRENT_DATE)
     ORDER BY effective_date DESC LIMIT 1;
    v_rate := COALESCE(v_rate, 1);
  END IF;

  PERFORM public._pret_lifecycle_begin();

  INSERT INTO public.purchase_returns(
    organization_id, business_id, branch_id, vendor_id, return_number, return_date, status,
    return_kind, goods_receipt_id, purchase_order_id, bill_id, warehouse_id,
    reason_code, reason, notes, currency, exchange_rate,
    subtotal, tax_amount, total, created_by)
  VALUES (
    v_org, _business_id, COALESCE(v_branch, (SELECT branch_id FROM public.warehouses WHERE id = _warehouse_id)),
    _vendor_id, NULL, COALESCE(_return_date, CURRENT_DATE), 'draft',
    _return_kind, _goods_receipt_id, v_grn.purchase_order_id, _bill_id,
    COALESCE(_warehouse_id, v_grn.warehouse_id),
    _reason_code, _reason, _notes, v_currency, v_rate, 0, 0, 0, v_uid)
  RETURNING id INTO v_id;

  v_totals := public._pret_write_lines(v_id, _lines);

  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = v_id;
  PERFORM public._pret_log(v_pr, 'created', NULL, 'draft', v_totals);

  RETURN jsonb_build_object('success', true, 'id', v_id,
                            'return_number', v_pr.return_number, 'totals', v_totals);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_update_draft(
  _id uuid, _row_version integer, _lines jsonb,
  _vendor_id uuid DEFAULT NULL, _return_date date DEFAULT NULL,
  _reason_code text DEFAULT NULL, _reason text DEFAULT NULL, _notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_totals jsonb;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft returns can be edited (this one is %)', v_pr.status USING ERRCODE='22023';
  END IF;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET vendor_id = COALESCE(_vendor_id, vendor_id),
         return_date = COALESCE(_return_date, return_date),
         reason_code = COALESCE(_reason_code, reason_code),
         reason = COALESCE(_reason, reason),
         notes = COALESCE(_notes, notes),
         row_version = row_version + 1,
         updated_at = now()
   WHERE id = _id;

  v_totals := public._pret_write_lines(_id, _lines);
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = _id;
  PERFORM public._pret_log(v_pr, 'updated', 'draft', 'draft', v_totals);
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version, 'totals', v_totals);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_submit(_id uuid, _row_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_req public.approval_requests;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft returns can be submitted' USING ERRCODE='22023';
  END IF;
  IF v_pr.total <= 0 THEN RAISE EXCEPTION 'This return has no value to submit' USING ERRCODE='22023'; END IF;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='submitted', submitted_at=now(), submitted_by=auth.uid(),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;

  v_req := public.approval_route(
    'purchase_return.approve', 'purchase_return', _id, v_pr.return_number,
    jsonb_build_object('amount', v_pr.total, 'total_amount', v_pr.total,
                       'currency', v_pr.currency, 'vendor_id', v_pr.vendor_id,
                       'return_kind', v_pr.return_kind, 'reason_code', v_pr.reason_code),
    jsonb_build_object('organization_id', v_pr.organization_id),
    'purchase_return.approve:' || _id::text || ':v' || v_pr.row_version::text,
    v_pr.business_id);

  IF v_req.id IS NOT NULL THEN
    PERFORM public._pret_lifecycle_begin();
    UPDATE public.purchase_returns SET approval_request_id = v_req.id, updated_at = now() WHERE id=_id;
    SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  END IF;

  PERFORM public._pret_log(v_pr, 'submitted', 'draft', 'submitted',
                           jsonb_build_object('approval_request_id', v_req.id));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version,
                            'gated', v_req.id IS NOT NULL, 'approval_request_id', v_req.id);
END $$;

CREATE OR REPLACE FUNCTION public._pret_apply_approval(_id uuid, _actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_code text; v_wro uuid;
BEGIN
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='approved', approved_at=now(), approved_by=_actor,
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;

  -- Goods returns become physical warehouse work; financial ones never do.
  IF v_pr.return_kind = 'goods' AND v_pr.warehouse_id IS NOT NULL AND v_pr.wms_return_order_id IS NULL THEN
    v_code := 'RTV-' || v_pr.return_number;
    INSERT INTO public.wms_return_orders(
      organization_id, business_id, branch_id, warehouse_id, code, return_kind,
      vendor_id, source_doc_type, source_doc_id, state, notes, created_by)
    VALUES (v_pr.organization_id, v_pr.business_id, v_pr.branch_id, v_pr.warehouse_id,
            v_code, 'vendor', v_pr.vendor_id, 'purchase_return', v_pr.id, 'draft',
            'Return to vendor for purchase return ' || v_pr.return_number, _actor)
    ON CONFLICT (business_id, warehouse_id, code) DO NOTHING
    RETURNING id INTO v_wro;

    IF v_wro IS NOT NULL THEN
      INSERT INTO public.wms_return_lines(
        return_order_id, organization_id, business_id, warehouse_id, product_id,
        lot_number, serial_number, expected_qty, received_qty, notes)
      SELECT v_wro, v_pr.organization_id, v_pr.business_id, v_pr.warehouse_id, ri.product_id,
             ri.lot_number, ri.serial_number, ri.quantity, 0, ri.return_reason
        FROM public.purchase_return_items ri
       WHERE ri.purchase_return_id = v_pr.id AND ri.product_id IS NOT NULL;

      PERFORM public._pret_lifecycle_begin();
      UPDATE public.purchase_returns SET wms_return_order_id = v_wro, updated_at = now() WHERE id=_id;
      SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
    END IF;
  END IF;

  PERFORM public._pret_log(v_pr, 'approved', 'submitted', 'approved',
                           jsonb_build_object('wms_return_order_id', v_pr.wms_return_order_id));
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_approve(_id uuid, _row_version integer, _comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_uid uuid := auth.uid();
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'submitted' THEN
    RAISE EXCEPTION 'Only submitted returns can be approved' USING ERRCODE='22023';
  END IF;
  IF v_pr.approval_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'This return is routed through the approval engine; decide it in the approvals inbox'
      USING ERRCODE='22023';
  END IF;
  IF NOT public.user_has_module_permission(v_uid, v_pr.organization_id, v_pr.business_id, 'purchases', 'approve') THEN
    RAISE EXCEPTION 'You do not have permission to approve purchase returns'
      USING ERRCODE='42501', HINT='GOV_MISSING_PERMISSION';
  END IF;
  PERFORM public.governance_assert_not_self(
    v_uid, COALESCE(v_pr.submitted_by, v_pr.created_by), 'purchase_return.approve',
    v_pr.organization_id, 'purchase_return', v_pr.id);

  PERFORM public._pret_apply_approval(_id, v_uid);
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version,
                            'wms_return_order_id', v_pr.wms_return_order_id);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_reject(_id uuid, _row_version integer, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'submitted' THEN
    RAISE EXCEPTION 'Only submitted returns can be rejected' USING ERRCODE='22023';
  END IF;
  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='rejected', rejected_at=now(), rejected_by=auth.uid(),
         rejected_reason=_reason, approval_request_id=NULL,
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'rejected', 'submitted', 'rejected', jsonb_build_object('reason', _reason));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_cancel(_id uuid, _row_version integer, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status NOT IN ('draft','submitted','approved') THEN
    RAISE EXCEPTION 'A % return can no longer be cancelled — stock or accounting is already in play', v_pr.status
      USING ERRCODE='22023';
  END IF;
  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='cancelled', cancelled_at=now(), cancelled_by=auth.uid(),
         approval_request_id=NULL, row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'cancelled', NULL, 'cancelled', jsonb_build_object('reason', _reason));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version);
END $$;

-- Physical execution: stock leaves here, exactly once.
CREATE OR REPLACE FUNCTION public.purchase_return_dispatch(
  _id uuid, _row_version integer, _dispatch_date date DEFAULT NULL, _tracking_reference text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_branch uuid; v_moves int := 0;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved returns can be dispatched' USING ERRCODE='22023';
  END IF;
  IF v_pr.return_kind <> 'goods' THEN
    RAISE EXCEPTION 'A financial adjustment has no goods to dispatch' USING ERRCODE='22023';
  END IF;
  IF v_pr.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'This return has no warehouse — stock cannot be released' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_movements
              WHERE reference_type='purchase_return' AND reference_id=_id) THEN
    RAISE EXCEPTION 'Stock for this return has already been released' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(v_pr.branch_id, w.branch_id) INTO v_branch
    FROM public.warehouses w WHERE w.id = v_pr.warehouse_id;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve the branch for this warehouse' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.stock_movements(
    organization_id, business_id, branch_id, warehouse_id, product_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, notes, created_by,
    lot_number, serial_number, source_packaging_id, source_uom_id, source_location_id, movement_date)
  SELECT v_pr.organization_id, v_pr.business_id, v_branch, v_pr.warehouse_id, ri.product_id, 'return',
         -ri.quantity, COALESCE(ri.unit_cost_basis, ri.unit_price), 'purchase_return', v_pr.id,
         'Purchase return ' || v_pr.return_number || ' dispatched to vendor',
         auth.uid(), ri.lot_number, ri.serial_number, ri.packaging_id, ri.display_uom_id,
         ri.location_id, COALESCE(_dispatch_date, CURRENT_DATE)::timestamptz
    FROM public.purchase_return_items ri
   WHERE ri.purchase_return_id = v_pr.id AND ri.product_id IS NOT NULL;
  GET DIAGNOSTICS v_moves = ROW_COUNT;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='dispatched', dispatched_at=now(), dispatched_by=auth.uid(),
         rma_reference=COALESCE(_tracking_reference, rma_reference),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'dispatched', 'approved', 'dispatched',
                           jsonb_build_object('stock_movements', v_moves,
                                              'tracking_reference', _tracking_reference));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version, 'stock_movements', v_moves);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_acknowledge(
  _id uuid, _row_version integer, _rma_reference text DEFAULT NULL, _notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'dispatched' THEN
    RAISE EXCEPTION 'Only dispatched returns can be acknowledged by the supplier' USING ERRCODE='22023';
  END IF;
  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='acknowledged', acknowledged_at=now(), acknowledged_by=auth.uid(),
         rma_reference=COALESCE(_rma_reference, rma_reference),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'acknowledged', 'dispatched', 'acknowledged',
                           jsonb_build_object('rma_reference', _rma_reference, 'notes', _notes));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version);
END $$;

-- Financial settlement: one debit note, built from the real lines.
CREATE OR REPLACE FUNCTION public.purchase_return_raise_credit(_id uuid, _row_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_items jsonb; v_res jsonb; v_cn_id uuid;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.vendor_credit_note_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already', true,
                              'vendor_credit_note_id', v_pr.vendor_credit_note_id);
  END IF;
  IF v_pr.status NOT IN ('dispatched','acknowledged')
     AND NOT (v_pr.return_kind = 'financial' AND v_pr.status = 'approved') THEN
    RAISE EXCEPTION 'A debit note can only be raised once the goods are dispatched (or for an approved financial adjustment)'
      USING ERRCODE='22023';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'description', ri.description, 'quantity', ri.quantity,
           'unit_price', ri.unit_price, 'tax_rate', COALESCE(ri.tax_rate,0),
           'tax_amount', COALESCE(ri.tax_amount,0), 'line_total', ri.line_total,
           'product_id', ri.product_id, 'sort_order', ri.sort_order)
           ORDER BY ri.sort_order)
    INTO v_items
    FROM public.purchase_return_items ri WHERE ri.purchase_return_id = _id;

  v_res := public.create_vendor_credit_note_atomic(
    v_pr.organization_id, v_pr.business_id, v_pr.branch_id, v_pr.vendor_id, v_pr.bill_id,
    CURRENT_DATE,
    'Vendor debit note for purchase return ' || v_pr.return_number ||
      COALESCE(' — ' || v_pr.reason_code, ''),
    v_items, true);

  v_cn_id := NULLIF(v_res->>'credit_note_id','')::uuid;
  IF v_cn_id IS NULL THEN v_cn_id := NULLIF(v_res->>'id','')::uuid; END IF;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET vendor_credit_note_id = v_cn_id, credited_at = now(), status = 'credited',
         row_version = row_version + 1, updated_at = now()
   WHERE id = _id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'credited', 'dispatched', 'credited', v_res);

  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version,
                            'vendor_credit_note_id', v_cn_id, 'credit_note', v_res);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_return_close(_id uuid, _row_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'credited' THEN
    RAISE EXCEPTION 'Only a credited return can be closed' USING ERRCODE='22023';
  END IF;
  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='closed', closed_at=now(), closed_by=auth.uid(),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'closed', 'credited', 'closed', '{}'::jsonb);
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version);
END $$;

-- ---------------------------------------------------------------------
-- 4. Governance mirror: approvals inbox decisions land back on the return
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mirror_approval_to_purchase_return()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pr public.purchase_returns; v_actor uuid;
BEGIN
  IF NEW.entity_type <> 'purchase_return' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = NEW.entity_id;
  IF v_pr.id IS NULL OR v_pr.status <> 'submitted' THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  IF NEW.status = 'approved' THEN
    PERFORM public._pret_apply_approval(v_pr.id, v_actor);
  ELSIF NEW.status IN ('rejected','cancelled') THEN
    PERFORM public._pret_lifecycle_begin();
    UPDATE public.purchase_returns
       SET status='rejected', rejected_at=now(), rejected_by=v_actor,
           rejected_reason=COALESCE(rejected_reason,'Rejected via governance engine'),
           approval_request_id=NULL, row_version=row_version+1, updated_at=now()
     WHERE id = v_pr.id;
    SELECT * INTO v_pr FROM public.purchase_returns WHERE id = v_pr.id;
    PERFORM public._pret_log(v_pr, 'rejected', 'submitted', 'rejected',
                             jsonb_build_object('approval_request_id', NEW.id));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_purchase_return ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_purchase_return
  AFTER INSERT OR UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_purchase_return();

-- ---------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'purchase_return_create(uuid,uuid,jsonb,text,uuid,uuid,uuid,date,text,text,text)',
    'purchase_return_update_draft(uuid,integer,jsonb,uuid,date,text,text,text)',
    'purchase_return_submit(uuid,integer)',
    'purchase_return_approve(uuid,integer,text)',
    'purchase_return_reject(uuid,integer,text)',
    'purchase_return_cancel(uuid,integer,text)',
    'purchase_return_dispatch(uuid,integer,date,text)',
    'purchase_return_acknowledge(uuid,integer,text,text)',
    'purchase_return_raise_credit(uuid,integer)',
    'purchase_return_close(uuid,integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public._pret_lifecycle_begin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pret_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pret_load(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pret_log(public.purchase_returns, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pret_apply_approval(uuid, uuid) FROM PUBLIC, anon, authenticated;