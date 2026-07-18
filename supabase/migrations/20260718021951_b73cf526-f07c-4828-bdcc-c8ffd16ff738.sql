
-- 1. Topic registry -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_event_topics (
  topic_prefix       text PRIMARY KEY,
  producer_domain    text NOT NULL,
  consumer_domains   text[] NOT NULL DEFAULT ARRAY[]::text[],
  description        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.business_event_topics TO authenticated;
GRANT ALL    ON public.business_event_topics TO service_role;

ALTER TABLE public.business_event_topics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Event topics readable by authenticated" ON public.business_event_topics;
CREATE POLICY "Event topics readable by authenticated"
  ON public.business_event_topics
  FOR SELECT
  TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public._touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_event_topics_touch ON public.business_event_topics;
CREATE TRIGGER trg_event_topics_touch
  BEFORE UPDATE ON public.business_event_topics
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description) VALUES
  ('supplier.',    'procurement', ARRAY['finance','analytics'],
     'Supplier master lifecycle: qualification, suspension, reinstatement, document expiry.'),
  ('procurement.', 'procurement', ARRAY['warehouse','inventory','finance','analytics'],
     'Procurement lifecycle: requisition, PO, ASN, goods receipt, bill, return, payment.'),
  ('sourcing.',    'procurement', ARRAY['analytics'],
     'Sourcing events: RFI/RFQ/RFP/auction publication, bidding, award.')
ON CONFLICT (topic_prefix) DO UPDATE SET
  producer_domain = EXCLUDED.producer_domain,
  consumer_domains = EXCLUDED.consumer_domains,
  description = EXCLUDED.description;

-- 2. Canonical create_goods_receipt wrapper ----------------------------------
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gr_id       uuid;
  v_org_id      uuid;
  v_branch_id   uuid;
  v_wh_id       uuid := _warehouse_id;
  v_number      text := _receipt_number;
  v_po          RECORD;
  v_line        jsonb;
  v_sort        int := 0;
  v_complete    jsonb;
  v_event_id    uuid;
BEGIN
  IF _business_id IS NULL OR _po_id IS NULL OR _actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'business_id, po_id and actor are required');
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'At least one receipt line is required');
  END IF;

  SELECT id, organization_id, business_id, warehouse_id, branch_id, po_number
    INTO v_po
    FROM public.purchase_orders
    WHERE id = _po_id FOR UPDATE;
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

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
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

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    v_org_id, v_branch_id, v_wh_id,
    'procurement.gr.posted', 'goods_receipt', v_gr_id,
    jsonb_build_object(
      'business_id', _business_id,
      'purchase_order_id', _po_id,
      'purchase_order_number', v_po.po_number,
      'goods_receipt_id', v_gr_id,
      'receipt_number', v_number,
      'warehouse_id', v_wh_id,
      'line_count', jsonb_array_length(_lines)
    ),
    'pending',
    'procurement.gr:' || v_gr_id::text || ':posted',
    _actor,
    'procurement'
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'goods_receipt_id', v_gr_id,
    'receipt_number', v_number,
    'event_id', v_event_id,
    'complete_result', v_complete
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_goods_receipt(uuid, uuid, jsonb, uuid, uuid, text, date) TO authenticated;

-- 3. Reconciliation view ------------------------------------------------------
CREATE OR REPLACE VIEW public.v_po_line_billed_progress AS
WITH matched AS (
  SELECT
    gri.purchase_order_item_id AS po_item_id,
    SUM(m.matched_quantity)    AS qty_via_grn_match
  FROM public.bill_grn_matches m
  JOIN public.goods_receipt_items gri ON gri.id = m.goods_receipt_item_id
  WHERE gri.purchase_order_item_id IS NOT NULL
  GROUP BY gri.purchase_order_item_id
),
direct_bill AS (
  SELECT
    bi.purchase_order_item_id AS po_item_id,
    SUM(bi.quantity)          AS qty_via_direct_bill_link
  FROM public.bill_items bi
  WHERE bi.purchase_order_item_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.bill_grn_matches m WHERE m.bill_item_id = bi.id
    )
  GROUP BY bi.purchase_order_item_id
)
SELECT
  poi.id                                       AS po_item_id,
  poi.purchase_order_id,
  poi.product_id,
  poi.quantity                                 AS quantity_ordered,
  COALESCE(poi.quantity_received, 0)           AS quantity_received,
  COALESCE(poi.quantity_billed,   0)           AS quantity_billed_stored,
  COALESCE(m.qty_via_grn_match, 0)             AS quantity_billed_via_grn,
  COALESCE(d.qty_via_direct_bill_link, 0)      AS quantity_billed_direct,
  COALESCE(m.qty_via_grn_match, 0) + COALESCE(d.qty_via_direct_bill_link, 0)
                                               AS quantity_billed_reconciled,
  COALESCE(poi.quantity_billed, 0)
    - (COALESCE(m.qty_via_grn_match, 0) + COALESCE(d.qty_via_direct_bill_link, 0))
                                               AS billed_drift,
  CASE
    WHEN COALESCE(poi.quantity, 0) = 0 THEN NULL
    WHEN COALESCE(poi.quantity_billed, 0) >= poi.quantity THEN 'billed'
    WHEN COALESCE(poi.quantity_billed, 0) > 0                THEN 'partially_billed'
    ELSE 'open'
  END                                           AS billing_state
FROM public.purchase_order_items poi
LEFT JOIN matched     m ON m.po_item_id = poi.id
LEFT JOIN direct_bill d ON d.po_item_id = poi.id;

GRANT SELECT ON public.v_po_line_billed_progress TO authenticated;
GRANT SELECT ON public.v_po_line_billed_progress TO service_role;

COMMENT ON VIEW public.v_po_line_billed_progress IS
  'Procurement P0: unified billed-progress view. billed_drift must be 0 for every row.';
