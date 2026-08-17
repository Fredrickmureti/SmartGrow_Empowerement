-- Ratchet (P2-1, milk simulation 2026-08-17): every receipt entry path must
-- leave the same PHYSICAL execution trail.
--
-- Before this guard, `receive_inbound_shipment` (ASN-direct) posted stock and
-- the GRNI accrual but created no licence plate and no putaway task, so the
-- goods existed financially with no instruction to put them anywhere. Only the
-- receiving-workspace path (`wms_post_receiving_session`) staged the receipt.

-- 1. Structural: the ASN path stages through the canonical staging writer.
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'receive_inbound_shipment';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'receive_inbound_shipment is missing';
  END IF;

  IF v_src NOT LIKE '%complete_goods_receipt_atomic%' THEN
    RAISE EXCEPTION 'receive_inbound_shipment no longer routes through the posting authority';
  END IF;

  IF v_src NOT LIKE '%receive_goods_to_wms%' THEN
    RAISE EXCEPTION 'receive_inbound_shipment must stage the receipt (licence plate + putaway task) via receive_goods_to_wms';
  END IF;

  IF v_src NOT LIKE '%wms_resolve_receiving_staging_location%' THEN
    RAISE EXCEPTION 'receive_inbound_shipment must resolve staging through the shared resolver';
  END IF;
END $$;

-- 2. Structural: staging refuses to invent stock. The plate quant may only be
--    created by RELIEVING an existing loose quant (P2-2 writer invariant).
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'receive_goods_to_wms';

  IF v_src NOT LIKE '%WMS_STAGING_UNRELIEVED_BALANCE%' THEN
    RAISE EXCEPTION 'receive_goods_to_wms must fail when there is no loose balance to relocate onto the plate';
  END IF;
END $$;

-- 3. Behavioural: every completed goods receipt raised after the guard landed
--    has a putaway task for each received line.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.goods_receipts gr
    JOIN public.goods_receipt_items gri ON gri.goods_receipt_id = gr.id
   WHERE gr.status = 'completed'
     AND gr.created_at >= timestamptz '2026-08-17 00:00:00+00'
     AND COALESCE(gri.quantity_received, 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.wms_tasks t
        WHERE t.task_type = 'putaway'
          AND (t.metadata->>'goods_receipt_item_id')::uuid = gri.id
     );

  IF v_n > 0 THEN
    RAISE EXCEPTION '% completed goods receipt line(s) landed in stock with no putaway task', v_n;
  END IF;
END $$;

-- 4. The drift audit reports the mixed plate/loose shape (P2-2 visibility).
DO $$
BEGIN
  IF pg_get_functiondef('public.check_stock_quant_drift(uuid)'::regprocedure)
       NOT LIKE '%stock_quants.mixed_scope%' THEN
    RAISE EXCEPTION 'check_stock_quant_drift must report mixed plate/location scope';
  END IF;
END $$;