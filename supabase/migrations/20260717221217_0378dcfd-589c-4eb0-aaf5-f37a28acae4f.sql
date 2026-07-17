-- Phase 7.1 — QC physical stock effects
-- Adds real stock_movements to open/accept/reject QC RPCs and provisions a
-- per-warehouse quarantine (qc_hold) location. Also fixes emit_qc_event to
-- use the actual business_event_outbox column names.

-- ---------------------------------------------------------------------------
-- 1) Backfill: ensure every warehouse has a QUARANTINE and a STOCK location.
-- ---------------------------------------------------------------------------
INSERT INTO public.stock_locations (organization_id, business_id, warehouse_id, code, name, location_type, usage, is_active)
SELECT w.organization_id, w.business_id, w.id, 'QUARANTINE', 'Quarantine', 'quarantine'::stock_location_type, 'inspection'::stock_location_usage, true
FROM public.warehouses w
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_locations l
  WHERE l.warehouse_id = w.id AND l.location_type = 'quarantine'
);

INSERT INTO public.stock_locations (organization_id, business_id, warehouse_id, code, name, location_type, usage, is_active, is_default, is_putaway_target)
SELECT w.organization_id, w.business_id, w.id, 'STOCK', 'Stock', 'internal'::stock_location_type, 'storage'::stock_location_usage, true, true, true
FROM public.warehouses w
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_locations l
  WHERE l.warehouse_id = w.id AND l.location_type = 'internal' AND l.usage = 'storage'
);

-- ---------------------------------------------------------------------------
-- 2) Helpers to locate the qc-hold and default putaway destinations.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_ensure_qc_hold(p_warehouse_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_wh public.warehouses;
BEGIN
  SELECT id INTO v_id FROM public.stock_locations
   WHERE warehouse_id = p_warehouse_id AND location_type = 'quarantine' AND is_active
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;

  INSERT INTO public.stock_locations (organization_id, business_id, warehouse_id, code, name, location_type, usage, is_active)
  VALUES (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'QUARANTINE', 'Quarantine',
          'quarantine'::stock_location_type, 'inspection'::stock_location_usage, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public._wms_default_putaway(p_warehouse_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_wh public.warehouses;
BEGIN
  SELECT id INTO v_id FROM public.stock_locations
   WHERE warehouse_id = p_warehouse_id
     AND location_type = 'internal' AND usage = 'storage' AND is_active
   ORDER BY is_default DESC, is_putaway_target DESC, putaway_priority DESC, created_at
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;

  INSERT INTO public.stock_locations (organization_id, business_id, warehouse_id, code, name, location_type, usage, is_active, is_default, is_putaway_target)
  VALUES (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'STOCK', 'Stock',
          'internal'::stock_location_type, 'storage'::stock_location_usage, true, true, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public._wms_ensure_qc_hold(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_default_putaway(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_ensure_qc_hold(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._wms_default_putaway(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Helper: post a two-row QC transfer into stock_movements.
--    Signed quantities: -qty from source, +qty to destination.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_qc_post_move(
  p_insp public.wms_qc_inspections,
  p_source_location uuid,
  p_dest_location uuid,
  p_qty numeric,
  p_movement_type text,
  p_note text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN; END IF;
  IF p_insp.product_id IS NULL THEN RETURN; END IF;

  -- Outbound from source
  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, warehouse_id, product_id,
    movement_type, quantity, source_location_id, destination_location_id,
    reference_type, reference_id, lot_number, serial_number,
    notes, created_by, movement_date
  ) VALUES (
    p_insp.organization_id, p_insp.business_id, p_insp.branch_id, p_insp.warehouse_id, p_insp.product_id,
    p_movement_type, -p_qty, p_source_location, p_dest_location,
    'wms_qc_inspection', p_insp.id, p_insp.lot_number, p_insp.serial_number,
    p_note, auth.uid(), now()
  );

  -- Inbound to destination
  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, warehouse_id, product_id,
    movement_type, quantity, source_location_id, destination_location_id,
    reference_type, reference_id, lot_number, serial_number,
    notes, created_by, movement_date
  ) VALUES (
    p_insp.organization_id, p_insp.business_id, p_insp.branch_id, p_insp.warehouse_id, p_insp.product_id,
    p_movement_type, p_qty, p_source_location, p_dest_location,
    'wms_qc_inspection', p_insp.id, p_insp.lot_number, p_insp.serial_number,
    p_note, auth.uid(), now()
  );
END; $$;

REVOKE ALL ON FUNCTION public._wms_qc_post_move(public.wms_qc_inspections, uuid, uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_qc_post_move(public.wms_qc_inspections, uuid, uuid, numeric, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4) Fix emit_qc_event to use correct business_event_outbox columns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_qc_event(
  p_type text, p_insp public.wms_qc_inspections
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, org_id, branch_id, warehouse_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      p_type, p_insp.organization_id, p_insp.branch_id, p_insp.warehouse_id,
      'wms_qc_inspection', p_insp.id,
      jsonb_build_object(
        'inspection_id', p_insp.id,
        'business_id', p_insp.business_id,
        'warehouse_id', p_insp.warehouse_id,
        'product_id', p_insp.product_id,
        'state', p_insp.state,
        'quantity', p_insp.quantity,
        'accepted_qty', p_insp.accepted_qty,
        'rejected_qty', p_insp.rejected_qty,
        'disposition', p_insp.disposition
      ),
      'wms.qc.' || p_insp.id || ':' || p_insp.state,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'qc event emission failed: %', SQLERRM;
  END;
END; $$;

-- ---------------------------------------------------------------------------
-- 5) Rewrite open_qc_inspection: post STOCK → QUARANTINE move for the qty
--    under inspection (sample_size when strategy='aql'/'skip', else quantity).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_qc_inspection(
  p_warehouse_id uuid,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_sample_size integer DEFAULT 0,
  p_sample_strategy text DEFAULT 'full'
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wh public.warehouses;
  v_row public.wms_qc_inspections;
  v_hold uuid;
  v_source uuid;
  v_hold_qty numeric;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  IF v_wh.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied to warehouse';
  END IF;

  INSERT INTO public.wms_qc_inspections (
    organization_id, business_id, warehouse_id,
    source_doc_type, source_doc_id, product_id, quantity,
    lot_number, serial_number, sample_size, sample_strategy,
    state, inspector_id, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, p_warehouse_id,
    p_source_doc_type, p_source_doc_id, p_product_id, p_quantity,
    p_lot_number, p_serial_number, p_sample_size, p_sample_strategy,
    'open', auth.uid(), auth.uid()
  ) RETURNING * INTO v_row;

  -- Physical stock effect: park the inspected quantity in QUARANTINE.
  IF p_product_id IS NOT NULL AND p_sample_strategy <> 'skip' THEN
    v_hold := public._wms_ensure_qc_hold(p_warehouse_id);
    v_source := public._wms_default_putaway(p_warehouse_id);
    v_hold_qty := CASE
      WHEN p_sample_strategy = 'aql' AND COALESCE(p_sample_size,0) > 0
        THEN LEAST(p_sample_size::numeric, p_quantity)
      ELSE p_quantity
    END;
    PERFORM public._wms_qc_post_move(v_row, v_source, v_hold, v_hold_qty,
      'qc_hold', 'QC hold for inspection ' || v_row.id::text);
  END IF;

  PERFORM public.emit_qc_event('warehouse.qc.opened', v_row);
  RETURN v_row;
END; $$;

GRANT EXECUTE ON FUNCTION public.open_qc_inspection(uuid,text,uuid,uuid,numeric,text,text,integer,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6) Rewrite accept_qc_inspection: release accepted qty back to STOCK.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_qc_inspection(
  p_inspection_id uuid,
  p_accepted_qty numeric,
  p_notes text DEFAULT NULL
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_insp public.wms_qc_inspections;
  v_state text;
  v_hold uuid;
  v_dest uuid;
BEGIN
  SELECT * INTO v_insp FROM public.wms_qc_inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inspection not found'; END IF;
  IF v_insp.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_insp.state NOT IN ('open','in_review') THEN
    RAISE EXCEPTION 'inspection already finalized (%)', v_insp.state;
  END IF;
  IF p_accepted_qty < 0 OR p_accepted_qty > v_insp.quantity THEN
    RAISE EXCEPTION 'accepted_qty out of range';
  END IF;

  v_state := CASE WHEN p_accepted_qty = v_insp.quantity THEN 'accepted' ELSE 'partially_accepted' END;

  UPDATE public.wms_qc_inspections
    SET state = v_state,
        accepted_qty = p_accepted_qty,
        rejected_qty = v_insp.quantity - p_accepted_qty,
        inspected_at = now(),
        inspector_id = COALESCE(v_insp.inspector_id, auth.uid()),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  IF v_insp.product_id IS NOT NULL AND p_accepted_qty > 0 THEN
    v_hold := public._wms_ensure_qc_hold(v_insp.warehouse_id);
    v_dest := public._wms_default_putaway(v_insp.warehouse_id);
    PERFORM public._wms_qc_post_move(v_insp, v_hold, v_dest, p_accepted_qty,
      'qc_release', 'QC release to stock for inspection ' || v_insp.id::text);
  END IF;

  PERFORM public.emit_qc_event('warehouse.qc.accepted', v_insp);
  RETURN v_insp;
END; $$;

GRANT EXECUTE ON FUNCTION public.accept_qc_inspection(uuid,numeric,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7) Rewrite reject_qc_inspection: dispose rejected qty from QUARANTINE
--    per disposition (scrap, RTV, rework/use_as_is).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_qc_inspection(
  p_inspection_id uuid,
  p_rejected_qty numeric,
  p_disposition text,
  p_notes text DEFAULT NULL
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_insp public.wms_qc_inspections;
  v_hold uuid;
  v_dest uuid;
  v_scrap_loc uuid;
  v_return_id uuid;
  v_bill record;
  v_seq int;
BEGIN
  SELECT * INTO v_insp FROM public.wms_qc_inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inspection not found'; END IF;
  IF v_insp.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_insp.state NOT IN ('open','in_review') THEN
    RAISE EXCEPTION 'inspection already finalized (%)', v_insp.state;
  END IF;
  IF p_disposition NOT IN ('return_to_vendor','scrap','rework','use_as_is') THEN
    RAISE EXCEPTION 'invalid disposition';
  END IF;
  IF p_rejected_qty <= 0 OR p_rejected_qty > v_insp.quantity THEN
    RAISE EXCEPTION 'rejected_qty out of range';
  END IF;

  UPDATE public.wms_qc_inspections
    SET state = 'rejected',
        rejected_qty = p_rejected_qty,
        accepted_qty = v_insp.quantity - p_rejected_qty,
        disposition = p_disposition,
        inspected_at = now(),
        inspector_id = COALESCE(v_insp.inspector_id, auth.uid()),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  IF v_insp.product_id IS NOT NULL AND p_rejected_qty > 0 THEN
    v_hold := public._wms_ensure_qc_hold(v_insp.warehouse_id);

    IF p_disposition IN ('rework','use_as_is') THEN
      v_dest := public._wms_default_putaway(v_insp.warehouse_id);
      PERFORM public._wms_qc_post_move(v_insp, v_hold, v_dest, p_rejected_qty,
        'qc_release', 'QC release (' || p_disposition || ') for inspection ' || v_insp.id::text);

    ELSIF p_disposition = 'scrap' THEN
      -- Ship to a virtual scrap location.
      SELECT id INTO v_scrap_loc FROM public.stock_locations
       WHERE warehouse_id = v_insp.warehouse_id AND location_type = 'scrap'
       ORDER BY created_at LIMIT 1;
      IF v_scrap_loc IS NULL THEN
        INSERT INTO public.stock_locations (organization_id, business_id, warehouse_id, code, name, location_type, usage, is_active)
        VALUES (v_insp.organization_id, v_insp.business_id, v_insp.warehouse_id, 'SCRAP', 'Scrap',
                'scrap'::stock_location_type, 'virtual'::stock_location_usage, true)
        RETURNING id INTO v_scrap_loc;
      END IF;
      PERFORM public._wms_qc_post_move(v_insp, v_hold, v_scrap_loc, p_rejected_qty,
        'qc_scrap', 'QC scrap for inspection ' || v_insp.id::text);

    ELSIF p_disposition = 'return_to_vendor' THEN
      -- Ship to a vendor-side virtual location, then seed a purchase_returns draft.
      SELECT id INTO v_scrap_loc FROM public.stock_locations
       WHERE business_id = v_insp.business_id AND location_type = 'vendor'
       ORDER BY created_at LIMIT 1;
      IF v_scrap_loc IS NULL THEN
        INSERT INTO public.stock_locations (organization_id, business_id, warehouse_id, code, name, location_type, usage, is_active)
        VALUES (v_insp.organization_id, v_insp.business_id, NULL, 'VENDOR-RTV', 'Vendor RTV',
                'vendor'::stock_location_type, 'virtual'::stock_location_usage, true)
        RETURNING id INTO v_scrap_loc;
      END IF;
      PERFORM public._wms_qc_post_move(v_insp, v_hold, v_scrap_loc, p_rejected_qty,
        'return_to_vendor', 'QC RTV for inspection ' || v_insp.id::text);

      -- Seed a purchase_returns draft when the source doc is a goods receipt.
      IF v_insp.source_doc_type = 'goods_receipt' AND v_insp.source_doc_id IS NOT NULL THEN
        SELECT b.id AS bill_id, b.vendor_id
          INTO v_bill
          FROM public.goods_receipts gr
          LEFT JOIN public.bills b ON b.id = gr.bill_id
         WHERE gr.id = v_insp.source_doc_id;
        IF v_bill.vendor_id IS NOT NULL THEN
          SELECT COALESCE(MAX((regexp_replace(return_number, '\D', '', 'g'))::int), 0) + 1
            INTO v_seq FROM public.purchase_returns
           WHERE business_id = v_insp.business_id
             AND return_number ~ ('^PR-' || to_char(now(), 'YYYYMM'));
          INSERT INTO public.purchase_returns (
            organization_id, business_id, branch_id, vendor_id, bill_id,
            return_number, return_date, status, reason, notes, created_by
          ) VALUES (
            v_insp.organization_id, v_insp.business_id, v_insp.branch_id,
            v_bill.vendor_id, v_bill.bill_id,
            'PR-' || to_char(now(), 'YYYYMM') || '-' || lpad(COALESCE(v_seq,1)::text, 4, '0'),
            current_date, 'draft',
            'QC reject from inspection ' || v_insp.id::text,
            p_notes, auth.uid()
          ) RETURNING id INTO v_return_id;

          INSERT INTO public.purchase_return_items (
            purchase_return_id, product_id, quantity, unit_price, line_total, return_reason
          ) VALUES (
            v_return_id, v_insp.product_id, p_rejected_qty, 0, 0,
            'QC reject: ' || COALESCE(p_notes, '')
          );
        END IF;
      END IF;
    END IF;
  END IF;

  PERFORM public.emit_qc_event('warehouse.qc.rejected', v_insp);
  RETURN v_insp;
END; $$;

GRANT EXECUTE ON FUNCTION public.reject_qc_inspection(uuid,numeric,text,text) TO authenticated;