
-- 1. Subscription registry ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_event_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         text NOT NULL,
  subscriber_name    text NOT NULL,
  handler_function   text NOT NULL,
  consumer_domain    text NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, subscriber_name)
);

GRANT SELECT ON public.business_event_subscriptions TO authenticated;
GRANT ALL    ON public.business_event_subscriptions TO service_role;
ALTER TABLE public.business_event_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Event subs readable by authenticated" ON public.business_event_subscriptions;
CREATE POLICY "Event subs readable by authenticated"
  ON public.business_event_subscriptions FOR SELECT TO authenticated USING (true);
DROP TRIGGER IF EXISTS trg_event_subs_touch ON public.business_event_subscriptions;
CREATE TRIGGER trg_event_subs_touch
  BEFORE UPDATE ON public.business_event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

-- 2. WMS subscriber: stock movements + PO progress ---------------------------
CREATE OR REPLACE FUNCTION public.wms_apply_gr_stock(_gr_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_grn RECORD; v_item RECORD;
  v_movement_count int := 0; v_total_cost numeric := 0;
  v_unit_cost numeric; v_raw_cost numeric; v_line_cost numeric;
  v_any_received boolean := false; v_all_received boolean;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id,
         purchase_order_id, receipt_number
    INTO v_grn FROM goods_receipts WHERE id = _gr_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;

  FOR v_item IN
    SELECT gri.id, gri.product_id, gri.purchase_order_item_id,
           gri.description, gri.quantity_received, gri.unit_cost_basis,
           gri.lot_number, gri.serial_number,
           poi.unit_price, poi.quantity AS po_quantity,
           poi.display_quantity AS poi_display_quantity,
           p.cost_price, p.track_inventory
      FROM goods_receipt_items gri
 LEFT JOIN purchase_order_items poi ON poi.id = gri.purchase_order_item_id
 LEFT JOIN products p              ON p.id   = gri.product_id
     WHERE gri.goods_receipt_id = _gr_id
  LOOP
    v_any_received := true;
    IF v_item.product_id IS NOT NULL AND COALESCE(v_item.track_inventory, true) THEN
      v_raw_cost := COALESCE(v_item.unit_price, v_item.cost_price, 0);
      IF v_item.unit_cost_basis = 'per_base_unit' THEN
        v_unit_cost := v_raw_cost;
      ELSIF v_item.purchase_order_item_id IS NOT NULL
            AND COALESCE(v_item.poi_display_quantity, 0) > 0
            AND COALESCE(v_item.po_quantity, 0) > 0
            AND v_item.po_quantity <> v_item.poi_display_quantity THEN
        v_unit_cost := v_raw_cost * v_item.poi_display_quantity / v_item.po_quantity;
      ELSE
        v_unit_cost := v_raw_cost;
      END IF;

      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes,
        lot_number, serial_number, created_by
      ) VALUES (
        v_grn.organization_id, v_grn.business_id, v_grn.branch_id, v_grn.warehouse_id,
        v_item.product_id, 'receipt', v_item.quantity_received, v_unit_cost,
        'goods_receipt', _gr_id,
        'GRN ' || v_grn.receipt_number || COALESCE(' — ' || v_item.description, ''),
        v_item.lot_number, v_item.serial_number, _actor
      );
      v_movement_count := v_movement_count + 1;
      v_line_cost := v_item.quantity_received * v_unit_cost;
      v_total_cost := v_total_cost + v_line_cost;
    END IF;
    IF v_item.purchase_order_item_id IS NOT NULL THEN
      UPDATE purchase_order_items
         SET quantity_received = COALESCE(quantity_received, 0) + v_item.quantity_received,
             receipt_status = CASE
               WHEN COALESCE(quantity_received, 0) + v_item.quantity_received >= quantity THEN 'received'
               ELSE 'partial'
             END
       WHERE id = v_item.purchase_order_item_id;
    END IF;
  END LOOP;

  SELECT bool_and(COALESCE(quantity_received, 0) >= quantity) INTO v_all_received
    FROM purchase_order_items WHERE purchase_order_id = v_grn.purchase_order_id;
  IF v_all_received THEN
    UPDATE purchase_orders SET status = 'received' WHERE id = v_grn.purchase_order_id;
  ELSIF v_any_received THEN
    UPDATE purchase_orders SET status = 'partial_received' WHERE id = v_grn.purchase_order_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'movement_count', v_movement_count, 'total_cost', v_total_cost);
END; $$;

GRANT EXECUTE ON FUNCTION public.wms_apply_gr_stock(uuid, uuid) TO authenticated, service_role;

-- 3. Finance subscriber: GR/NI journal entry ---------------------------------
CREATE OR REPLACE FUNCTION public.finance_post_gr_journal(_gr_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_grn RECORD; v_total_cost numeric := 0;
  v_inventory_acct uuid; v_grni_acct uuid; v_journal_id uuid;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id, receipt_number
    INTO v_grn FROM goods_receipts WHERE id = _gr_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;

  -- Total cost = SUM(quantity_received * scaled unit_cost), replayed from movements
  -- just written by the WMS subscriber. This keeps Finance independent of the
  -- WMS return value and idempotent when replayed from an event stream.
  SELECT COALESCE(SUM(quantity * unit_cost), 0)
    INTO v_total_cost
    FROM stock_movements
   WHERE reference_type = 'goods_receipt' AND reference_id = _gr_id;

  IF v_total_cost <= 0 THEN
    RETURN jsonb_build_object('success', true, 'total_cost', 0, 'journal_id', NULL);
  END IF;

  SELECT id INTO v_inventory_acct FROM accounts
   WHERE organization_id = v_grn.organization_id AND business_id = v_grn.business_id
     AND detail_type = 'inventory' AND is_active = true LIMIT 1;
  SELECT id INTO v_grni_acct FROM accounts
   WHERE business_id = v_grn.business_id AND system_role = 'grni' LIMIT 1;

  IF v_inventory_acct IS NULL OR v_grni_acct IS NULL THEN
    RETURN jsonb_build_object('success', true, 'total_cost', v_total_cost, 'journal_id', NULL,
      'warning', 'Inventory or GR/NI account missing — journal skipped');
  END IF;

  INSERT INTO journal_entries (
    organization_id, business_id, branch_id, entry_date,
    reference_type, reference_id, description, status, created_by
  ) VALUES (
    v_grn.organization_id, v_grn.business_id, v_grn.branch_id, current_date,
    'goods_receipt', _gr_id,
    'GRN ' || v_grn.receipt_number || ' — Inventory receipt',
    'posted', _actor
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description) VALUES
    (v_journal_id, v_inventory_acct, v_total_cost, 0, 'Inventory in (GRN ' || v_grn.receipt_number || ')'),
    (v_journal_id, v_grni_acct,      0, v_total_cost, 'GR/NI accrual (GRN ' || v_grn.receipt_number || ')');

  RETURN jsonb_build_object('success', true, 'total_cost', v_total_cost, 'journal_id', v_journal_id);
END; $$;

GRANT EXECUTE ON FUNCTION public.finance_post_gr_journal(uuid, uuid) TO authenticated, service_role;

-- 4. Register subscriptions --------------------------------------------------
INSERT INTO public.business_event_subscriptions
  (event_type, subscriber_name, handler_function, consumer_domain)
VALUES
  ('procurement.gr.posted', 'wms.gr_stock_applier',   'public.wms_apply_gr_stock(uuid,uuid)',      'warehouse'),
  ('procurement.gr.posted', 'finance.gr_journal_poster','public.finance_post_gr_journal(uuid,uuid)','finance')
ON CONFLICT (event_type, subscriber_name) DO UPDATE
  SET handler_function = EXCLUDED.handler_function,
      consumer_domain  = EXCLUDED.consumer_domain,
      is_active        = true;

-- 5. Reconstruct complete_goods_receipt_atomic — no more inline stock/GL -----
CREATE OR REPLACE FUNCTION public.complete_goods_receipt_atomic(p_grn_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_grn RECORD;
  v_stock_result   jsonb;
  v_finance_result jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id,
         purchase_order_id, receipt_number, status
    INTO v_grn FROM goods_receipts WHERE id = p_grn_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found');
  END IF;
  IF v_grn.status = 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt already completed');
  END IF;
  IF v_grn.warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt has no warehouse — set warehouse_id before completing');
  END IF;

  -- Delegate to domain-owned subscribers. Called inline for atomicity; a
  -- future async event pump can invoke the same functions from the outbox
  -- without changing their contract.
  v_stock_result := public.wms_apply_gr_stock(p_grn_id, p_user_id);
  IF NOT COALESCE((v_stock_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'wms_apply_gr_stock failed: %', v_stock_result->>'error';
  END IF;

  v_finance_result := public.finance_post_gr_journal(p_grn_id, p_user_id);
  IF NOT COALESCE((v_finance_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'finance_post_gr_journal failed: %', v_finance_result->>'error';
  END IF;

  UPDATE goods_receipts SET status = 'completed', updated_at = now() WHERE id = p_grn_id;

  -- Canonical emission (single emitter).
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    v_grn.organization_id, v_grn.branch_id, v_grn.warehouse_id,
    'procurement.gr.posted', 'goods_receipt', p_grn_id,
    jsonb_build_object(
      'business_id', v_grn.business_id,
      'purchase_order_id', v_grn.purchase_order_id,
      'goods_receipt_id', p_grn_id,
      'receipt_number', v_grn.receipt_number,
      'warehouse_id', v_grn.warehouse_id,
      'movement_count', v_stock_result->'movement_count',
      'total_cost',     v_stock_result->'total_cost',
      'journal_id',     v_finance_result->'journal_id'
    ),
    'pending',
    'procurement.gr:' || p_grn_id::text || ':posted',
    p_user_id,
    'procurement'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'movement_count', v_stock_result->'movement_count',
    'total_cost',     v_stock_result->'total_cost',
    'journal_id',     v_finance_result->'journal_id'
  );
END; $$;

-- 6. Strip the duplicate emit from create_goods_receipt ----------------------
-- complete_goods_receipt_atomic is now the single emitter. Rewrite the
-- wrapper so it only orchestrates header/lines creation and delegates.
CREATE OR REPLACE FUNCTION public.create_goods_receipt(
  _business_id      uuid,
  _po_id            uuid,
  _lines            jsonb,
  _actor            uuid,
  _warehouse_id     uuid DEFAULT NULL,
  _receipt_number   text DEFAULT NULL,
  _receipt_date     date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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

  SELECT id, organization_id, business_id, warehouse_id, branch_id, po_number
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
    INSERT INTO public.goods_receipt_items (
      goods_receipt_id, purchase_order_item_id, product_id,
      description, quantity_ordered, quantity_received,
      lot_number, serial_number, notes, sort_order, branch_id
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
      v_branch_id
      FROM public.purchase_order_items poi
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
END; $$;

GRANT EXECUTE ON FUNCTION public.create_goods_receipt(uuid, uuid, jsonb, uuid, uuid, text, date) TO authenticated;

-- 7. Commit-time invariant: forbidden refs must be gone ----------------------
DO $$
DECLARE
  v_src text;
  v_forbidden text[] := ARRAY['stock_movements','stock_quants','cost_layers','journal_entries','journal_entry_lines'];
  v_tbl text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_goods_receipt_atomic';
  FOREACH v_tbl IN ARRAY v_forbidden LOOP
    IF v_src ~* ('\m' || v_tbl || '\M') THEN
      RAISE EXCEPTION 'Procurement P0 invariant violated: complete_goods_receipt_atomic still references %', v_tbl;
    END IF;
  END LOOP;
END $$;
