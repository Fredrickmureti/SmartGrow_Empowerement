-- Returns Phase 5 — server-side evidence rule + return label templates.

-- 1) Evidence rule: damaged / defective lines need at least one photo before
--    a disposition may be persisted. Enforced server-side; the client only
--    mirrors the rule for affordance.
CREATE OR REPLACE FUNCTION public.wms_disposition_return_line(
  p_line_id uuid,
  p_row_version integer,
  p_disposition public.wms_return_disposition DEFAULT NULL,
  p_restock_qty numeric DEFAULT NULL,
  p_quarantine_qty numeric DEFAULT 0,
  p_scrap_qty numeric DEFAULT 0,
  p_destination_location_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_line public.wms_return_lines%ROWTYPE;
  v_ord public.wms_return_orders%ROWTYPE;
  v_rule public.wms_return_disposition_rules%ROWTYPE;
  v_disp public.wms_return_disposition;
  v_dest uuid := p_destination_location_id;
  v_restock numeric;
  v_quar numeric := COALESCE(p_quarantine_qty, 0);
  v_scrap numeric := COALESCE(p_scrap_qty, 0);
  v_new_rv integer;
  v_photos integer;
BEGIN
  SELECT * INTO v_line FROM public.wms_return_lines WHERE id = p_line_id FOR UPDATE;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'return line % not found', p_line_id USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = v_line.return_order_id;
  IF NOT public.user_can_access_business(auth.uid(), v_line.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_line.row_version <> p_row_version THEN
    RAISE EXCEPTION 'return line changed since it was loaded (row_version % <> %)', v_line.row_version, p_row_version
      USING ERRCODE = '40001';
  END IF;
  IF v_line.posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'line already posted; disposition is immutable' USING ERRCODE = '22023';
  END IF;
  IF v_line.captured_at IS NULL THEN
    RAISE EXCEPTION 'line must be captured before disposition' USING ERRCODE = '22023';
  END IF;

  -- Photographic evidence is mandatory for damage / defect claims. Count the
  -- rows rather than trusting the denormalised photo_count column.
  IF v_line.condition_code IN ('damaged', 'defective') THEN
    SELECT count(*) INTO v_photos
      FROM public.wms_return_photos p
     WHERE p.return_line_id = v_line.id;
    IF COALESCE(v_photos, 0) = 0 THEN
      UPDATE public.wms_return_lines
         SET blocked_reason = 'Photographic evidence required for a '
                              || v_line.condition_code::text || ' line',
             updated_at = now()
       WHERE id = v_line.id;
      RAISE EXCEPTION 'photographic evidence is required before dispositioning a % line', v_line.condition_code
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Rule default when the caller did not force a disposition.
  IF p_disposition IS NULL THEN
    SELECT * INTO v_rule
      FROM public.wms_return_disposition_rules r
     WHERE r.business_id = v_line.business_id
       AND r.is_active
       AND (r.warehouse_id IS NULL OR r.warehouse_id = v_line.warehouse_id)
       AND (r.return_kind IS NULL OR r.return_kind = v_ord.return_kind)
       AND (r.condition_code IS NULL OR r.condition_code = v_line.condition_code)
       AND (r.product_id IS NULL OR r.product_id = v_line.product_id)
       AND (r.customer_id IS NULL OR r.customer_id = v_ord.customer_id)
     ORDER BY r.priority, r.created_at
     LIMIT 1;
    v_disp := v_rule.disposition;
    v_dest := COALESCE(v_dest, v_rule.destination_location_id);
    IF v_disp IS NULL THEN
      RAISE EXCEPTION 'no disposition supplied and no matching disposition rule' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_rule.requires_inspection, true) AND v_line.inspection_state IN ('pending','inspecting') THEN
      RAISE EXCEPTION 'disposition rule "%" requires a concluded inspection', v_rule.name USING ERRCODE = '22023';
    END IF;
  ELSE
    v_disp := p_disposition;
  END IF;

  v_restock := COALESCE(p_restock_qty,
    CASE WHEN v_disp = 'restock' THEN COALESCE(v_line.received_qty,0) - v_quar - v_scrap ELSE 0 END);
  IF v_disp = 'quarantine' AND p_quarantine_qty IS NULL THEN v_quar := COALESCE(v_line.received_qty,0); END IF;
  IF v_disp = 'scrap' AND COALESCE(p_scrap_qty,0) = 0 THEN v_scrap := COALESCE(v_line.received_qty,0) - v_restock - v_quar; END IF;

  IF v_restock < 0 OR v_quar < 0 OR v_scrap < 0 THEN
    RAISE EXCEPTION 'disposition quantities must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF (v_restock + v_quar + v_scrap) > COALESCE(v_line.received_qty, 0) THEN
    RAISE EXCEPTION 'disposition quantities (%) exceed received quantity (%)',
      v_restock + v_quar + v_scrap, COALESCE(v_line.received_qty,0) USING ERRCODE = '22023';
  END IF;

  IF v_dest IS NOT NULL THEN
    PERFORM 1 FROM public.stock_locations l
     WHERE l.id = v_dest AND l.warehouse_id = v_line.warehouse_id AND l.is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination location is not an active location of this warehouse' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_rv := v_line.row_version + 1;
  UPDATE public.wms_return_lines SET
    disposition             = v_disp,
    restock_qty             = v_restock,
    quarantine_qty          = v_quar,
    scrap_qty               = v_scrap,
    destination_location_id = COALESCE(v_dest, destination_location_id),
    dispositioned_by        = auth.uid(),
    dispositioned_at        = now(),
    blocked_reason          = NULL,
    notes                   = COALESCE(p_notes, notes),
    row_version             = v_new_rv,
    updated_at              = now()
  WHERE id = v_line.id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.line_dispositioned',
    'wms.return:' || v_line.id::text || ':line_dispositioned:' || v_new_rv::text,
    v_line.organization_id, v_line.business_id,
    jsonb_build_object(
      'aggregate_id', v_line.return_order_id, 'line_id', v_line.id,
      'warehouse_id', v_line.warehouse_id, 'branch_id', v_ord.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'extra', jsonb_build_object(
        'disposition', v_disp, 'restock_qty', v_restock,
        'quarantine_qty', v_quar, 'scrap_qty', v_scrap,
        'destination_location_id', v_dest,
        'rule_id', v_rule.id
      )
    )
  );

  RETURN jsonb_build_object(
    'line_id', v_line.id, 'row_version', v_new_rv, 'disposition', v_disp,
    'restock_qty', v_restock, 'quarantine_qty', v_quar, 'scrap_qty', v_scrap
  );
END $$;

REVOKE ALL ON FUNCTION public.wms_disposition_return_line(uuid,integer,public.wms_return_disposition,numeric,numeric,numeric,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_disposition_return_line(uuid,integer,public.wms_return_disposition,numeric,numeric,numeric,uuid,text) TO authenticated, service_role;

-- 2) Returns label templates ------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_seed_returns_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_receipt jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 3,  'text','RETURN RECEIVED', 'fontSize', 4, 'bold', true),
      jsonb_build_object('id','rma','type','variable','xMm', 4, 'yMm', 10, 'token','rma_reference','fontSize', 3, 'prefix','RMA: '),
      jsonb_build_object('id','prd','type','variable','xMm', 4, 'yMm', 16, 'token','product_name','fontSize', 3),
      jsonb_build_object('id','cnd','type','variable','xMm', 4, 'yMm', 22, 'token','condition_code','fontSize', 3, 'prefix','Condition: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 28, 'token','return_code','symbology','code128','heightMm', 18, 'moduleMm', 0.4, 'hri', true)
    )
  );
  v_disp jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','variable','xMm', 4, 'yMm', 3,  'token','disposition','fontSize', 4, 'bold', true),
      jsonb_build_object('id','prd','type','variable','xMm', 4, 'yMm', 10, 'token','product_name','fontSize', 3),
      jsonb_build_object('id','qty','type','variable','xMm', 4, 'yMm', 16, 'token','quantity','fontSize', 3, 'prefix','Qty: '),
      jsonb_build_object('id','dst','type','variable','xMm', 4, 'yMm', 22, 'token','destination_bin','fontSize', 3, 'prefix','To: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 28, 'token','return_code','symbology','code128','heightMm', 18, 'moduleMm', 0.4, 'hri', true)
    )
  );
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'return_receipt', 'wms.label.return_receipt', 'Return Receipt (WMS)', 'zpl'::label_engine,
     '', v_receipt, 'mm', 102, 51, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();

  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'disposition', 'wms.label.disposition', 'Return Disposition (WMS)', 'zpl'::label_engine,
     '', v_disp, 'mm', 102, 51, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_returns_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_returns_label_templates(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_seed_default_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.wms_seed_base_label_templates(_org_id, _actor);
  PERFORM public.wms_seed_receiving_label_templates(_org_id, _actor);
  PERFORM public.wms_seed_returns_label_templates(_org_id, _actor);
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) TO authenticated, service_role;

DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT org_id FROM public.label_templates WHERE template_key = 'wms.label.lpn'
  LOOP
    PERFORM public.wms_seed_returns_label_templates(r.org_id, NULL);
  END LOOP;
END $backfill$;