-- Phase 3.1 QC lifecycle: typed resolution
DO $$ BEGIN
  CREATE TYPE public.qc_resolution_kind AS ENUM (
    'accept',
    'reject_return_to_supplier',
    'reject_scrap',
    'conditional_release',
    'rework',
    'use_as_is'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.wms_qc_inspections
  ADD COLUMN IF NOT EXISTS resolution_kind public.qc_resolution_kind,
  ADD COLUMN IF NOT EXISTS resolution_notes text;

-- Backfill from free-text disposition
UPDATE public.wms_qc_inspections
   SET resolution_kind = CASE disposition
     WHEN 'return_to_vendor' THEN 'reject_return_to_supplier'::public.qc_resolution_kind
     WHEN 'scrap'            THEN 'reject_scrap'::public.qc_resolution_kind
     WHEN 'rework'           THEN 'rework'::public.qc_resolution_kind
     WHEN 'use_as_is'        THEN 'use_as_is'::public.qc_resolution_kind
     ELSE NULL
   END
 WHERE disposition IS NOT NULL AND resolution_kind IS NULL;

-- accept_qc_inspection: stamp resolution_kind = accept / conditional_release
CREATE OR REPLACE FUNCTION public.accept_qc_inspection(p_inspection_id uuid, p_accepted_qty numeric, p_notes text DEFAULT NULL::text)
 RETURNS public.wms_qc_inspections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_insp public.wms_qc_inspections;
  v_state text;
  v_res public.qc_resolution_kind;
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

  IF p_accepted_qty = v_insp.quantity THEN
    v_state := 'accepted'; v_res := 'accept';
  ELSE
    v_state := 'partially_accepted'; v_res := 'conditional_release';
  END IF;

  UPDATE public.wms_qc_inspections
    SET state           = v_state,
        accepted_qty    = p_accepted_qty,
        rejected_qty    = v_insp.quantity - p_accepted_qty,
        inspected_at    = now(),
        inspector_id    = COALESCE(v_insp.inspector_id, auth.uid()),
        notes           = COALESCE(p_notes, notes),
        resolution_kind = v_res,
        resolution_notes= COALESCE(p_notes, resolution_notes)
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  IF v_insp.product_id IS NOT NULL AND p_accepted_qty > 0 THEN
    v_hold := public._wms_ensure_qc_hold(v_insp.warehouse_id);
    v_dest := public._wms_default_putaway(v_insp.warehouse_id);
    PERFORM public._wms_qc_post_move(v_insp, v_hold, v_dest, p_accepted_qty,
      'qc_release', 'QC release to stock for inspection ' || v_insp.id::text);
  END IF;

  RETURN v_insp;
END; $function$;

-- reject_qc_inspection: stamp resolution_kind derived from disposition
CREATE OR REPLACE FUNCTION public.reject_qc_inspection(p_inspection_id uuid, p_rejected_qty numeric, p_disposition text, p_notes text DEFAULT NULL::text)
 RETURNS public.wms_qc_inspections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_insp public.wms_qc_inspections;
  v_res public.qc_resolution_kind;
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

  v_res := CASE p_disposition
    WHEN 'return_to_vendor' THEN 'reject_return_to_supplier'::public.qc_resolution_kind
    WHEN 'scrap'            THEN 'reject_scrap'::public.qc_resolution_kind
    WHEN 'rework'           THEN 'rework'::public.qc_resolution_kind
    WHEN 'use_as_is'        THEN 'use_as_is'::public.qc_resolution_kind
  END;

  UPDATE public.wms_qc_inspections
    SET state            = 'rejected',
        rejected_qty     = p_rejected_qty,
        accepted_qty     = v_insp.quantity - p_rejected_qty,
        disposition      = p_disposition,
        resolution_kind  = v_res,
        resolution_notes = COALESCE(p_notes, resolution_notes),
        inspected_at     = now(),
        inspector_id     = COALESCE(v_insp.inspector_id, auth.uid()),
        notes            = COALESCE(p_notes, notes)
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  IF v_insp.product_id IS NOT NULL AND p_rejected_qty > 0 THEN
    v_hold := public._wms_ensure_qc_hold(v_insp.warehouse_id);

    IF p_disposition IN ('rework','use_as_is') THEN
      v_dest := public._wms_default_putaway(v_insp.warehouse_id);
      PERFORM public._wms_qc_post_move(v_insp, v_hold, v_dest, p_rejected_qty,
        'qc_release', 'QC release (' || p_disposition || ') for inspection ' || v_insp.id::text);

    ELSIF p_disposition = 'scrap' THEN
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

  RETURN v_insp;
END; $function$;

-- Extend wms_transition_qc to accept optional typed resolution in payload
CREATE OR REPLACE FUNCTION public.wms_transition_qc(p_qc_id uuid, p_to_state text, p_row_version integer, p_reason text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.wms_qc_inspections%ROWTYPE;
  v_from text;
  v_allowed boolean := false;
  v_new_rv integer;
  v_res_txt text;
  v_res public.qc_resolution_kind;
BEGIN
  IF p_to_state NOT IN ('pending','in_progress','passed','failed','conditional','closed','cancelled') THEN
    RAISE EXCEPTION 'Unknown QC state %', p_to_state USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.wms_qc_inspections WHERE id = p_qc_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QC inspection not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'pending'     AND p_to_state IN ('in_progress','cancelled')                      THEN true
    WHEN v_from = 'in_progress' AND p_to_state IN ('passed','failed','conditional','cancelled')    THEN true
    WHEN v_from IN ('passed','failed','conditional') AND p_to_state IN ('closed','cancelled')      THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal QC transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  v_res_txt := NULLIF(p_payload->>'resolution_kind','');
  IF v_res_txt IS NOT NULL THEN
    BEGIN
      v_res := v_res_txt::public.qc_resolution_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Unknown resolution_kind %', v_res_txt USING ERRCODE = '22023';
    END;
    -- Sanity: only allow resolution stamping on terminal-ish states
    IF p_to_state NOT IN ('passed','failed','conditional','closed') THEN
      RAISE EXCEPTION 'resolution_kind not permitted for state %', p_to_state USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_qc_inspections SET
    state            = p_to_state,
    row_version      = v_new_rv,
    inspector_id     = COALESCE(inspector_id,  CASE WHEN p_to_state = 'in_progress' THEN auth.uid() END),
    inspected_at     = COALESCE(inspected_at,  CASE WHEN p_to_state IN ('passed','failed','conditional') THEN now() END),
    resolution_kind  = COALESCE(v_res, resolution_kind),
    resolution_notes = COALESCE(NULLIF(p_payload->>'resolution_notes',''), resolution_notes),
    updated_at       = now()
  WHERE id = p_qc_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.qc.' || p_to_state,
    'wms.qc:' || p_qc_id::text || ':' || p_to_state,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_qc_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'resolution_kind', COALESCE(v_res::text, (SELECT resolution_kind::text FROM public.wms_qc_inspections WHERE id = p_qc_id)),
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state, 'resolution_kind', v_res);
END;
$function$;