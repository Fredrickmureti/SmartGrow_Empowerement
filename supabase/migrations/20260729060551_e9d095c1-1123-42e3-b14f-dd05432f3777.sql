-- =====================================================================
-- WMS Phase 2.2 — Canonical label templates (LPN, Bin, Shipping) via
-- label_templates.body_json (visual LabelDoc) + Packing Slip via
-- document_template_ast (system scope, AST pipeline).
--
-- Idempotent: safe to re-run. Uses ON CONFLICT on the existing
-- (org_id, template_key, coalesce(media_profile_id, sentinel)) partial
-- unique index (WHERE branch_id IS NULL).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.wms_seed_default_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sentinel uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_lpn_doc  jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 4, 'text','LICENSE PLATE', 'fontSize', 3, 'bold', true),
      jsonb_build_object('id','wh', 'type','variable','xMm', 4, 'yMm', 9, 'token','warehouse_name','fontSize', 3),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 15, 'token','lpn_code','symbology','code128','heightMm', 20, 'moduleMm', 0.4, 'hri', true),
      jsonb_build_object('id','loc','type','variable','xMm', 4, 'yMm', 44, 'token','current_location','fontSize', 3, 'prefix','Loc: '),
      jsonb_build_object('id','ts', 'type','variable','xMm', 4, 'yMm', 50, 'token','created_at','fontSize', 2, 'prefix','Printed: ')
    )
  );
  v_bin_doc  jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','loc','type','variable','xMm', 3, 'yMm', 2, 'token','location_name','fontSize', 3, 'bold', true),
      jsonb_build_object('id','zn', 'type','variable','xMm', 3, 'yMm', 6, 'token','zone_name','fontSize', 2, 'prefix','Zone: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 3, 'yMm', 10, 'token','bin_code','symbology','code128','heightMm', 14, 'moduleMm', 0.33, 'hri', true)
    )
  );
  v_ship_doc jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','from','type','variable','xMm', 4, 'yMm', 4,  'token','ship_from','fontSize', 2, 'prefix','From: '),
      jsonb_build_object('id','to1', 'type','variable','xMm', 4, 'yMm', 12, 'token','customer_name','fontSize', 4, 'bold', true, 'prefix','TO '),
      jsonb_build_object('id','to2', 'type','variable','xMm', 4, 'yMm', 20, 'token','ship_to_address','fontSize', 3),
      jsonb_build_object('id','ord', 'type','variable','xMm', 4, 'yMm', 36, 'token','order_number','fontSize', 3, 'prefix','Order '),
      jsonb_build_object('id','svc', 'type','variable','xMm', 60,'yMm', 36, 'token','carrier_service','fontSize', 3),
      jsonb_build_object('id','bc',  'type','barcode', 'xMm', 4, 'yMm', 46, 'token','tracking_number','symbology','code128','heightMm', 22, 'moduleMm', 0.4, 'hri', true),
      jsonb_build_object('id','wt',  'type','variable','xMm', 4, 'yMm', 78, 'token','package_weight','fontSize', 2, 'prefix','Weight: '),
      jsonb_build_object('id','pcs', 'type','variable','xMm', 60,'yMm', 78, 'token','piece_count','fontSize', 2, 'prefix','Pieces: ')
    )
  );
BEGIN
  -- LPN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'pallet', 'wms.label.lpn', 'License Plate (WMS)', 'zpl'::label_engine,
     '', v_lpn_doc, 'mm', 102, 76, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json,
    engine    = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm  = EXCLUDED.width_mm,
    height_mm = EXCLUDED.height_mm,
    name      = EXCLUDED.name,
    is_default = true,
    active    = true,
    updated_at = now();

  -- Bin
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'bin', 'wms.label.bin', 'Bin / Location (WMS)', 'zpl'::label_engine,
     '', v_bin_doc, 'mm', 50, 30, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json,
    engine    = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm  = EXCLUDED.width_mm,
    height_mm = EXCLUDED.height_mm,
    name      = EXCLUDED.name,
    is_default = true,
    active    = true,
    updated_at = now();

  -- Shipping
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'shipping_label', 'wms.label.shipping', 'Shipping (WMS)', 'zpl'::label_engine,
     '', v_ship_doc, 'mm', 102, 152, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json,
    engine    = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm  = EXCLUDED.width_mm,
    height_mm = EXCLUDED.height_mm,
    name      = EXCLUDED.name,
    is_default = true,
    active    = true,
    updated_at = now();
END $$;

GRANT EXECUTE ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) TO authenticated, service_role;

-- =====================================================================
-- System-scope AST for the WMS packing slip. Upgrade the generic
-- system default with LPN-summary block so pack stations can print the
-- warehouse-shaped slip through the standard document renderer.
-- =====================================================================
UPDATE public.document_template_ast
SET ast = jsonb_build_object(
  'version', 1,
  'kind', 'inventory.packing_slip',
  'media_class', 'a4_portrait',
  'blocks', jsonb_build_array(
    jsonb_build_object('type','header', 'variant','branded'),
    jsonb_build_object('type','meta',   'fields', jsonb_build_array('order_number','ship_date','carrier_service','tracking_number')),
    jsonb_build_object('type','party',  'role','customer'),
    jsonb_build_object('type','table',  'preset','line_items', 'columns', jsonb_build_array('sku','description','ordered_qty','shipped_qty','uom')),
    jsonb_build_object('type','lpn_summary', 'columns', jsonb_build_array('lpn_code','line_count','total_qty')),
    jsonb_build_object('type','totals', 'preset','count_only', 'fields', jsonb_build_array('line_count','carton_count','total_qty')),
    jsonb_build_object('type','notes',  'source','terms'),
    jsonb_build_object('type','footer', 'variant','branded')
  )
),
label = 'System default — WMS Packing Slip',
updated_at = now()
WHERE kind_code = 'inventory.packing_slip'
  AND scope = 'system'
  AND is_default = true;

-- =====================================================================
-- Back-fill every existing org so the canonical templates are present
-- immediately. Cheap, idempotent — safe on large tenant sets.
-- =====================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.wms_seed_default_label_templates(r.id, NULL);
  END LOOP;
END $$;
