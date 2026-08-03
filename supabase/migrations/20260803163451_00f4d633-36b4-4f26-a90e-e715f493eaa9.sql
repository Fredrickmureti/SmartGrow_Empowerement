-- Yard Phase 4 — printable trailer placard + yard slot labels (ADR 0086).

CREATE OR REPLACE FUNCTION public.wms_seed_yard_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- Hung on the trailer while it is parked in the yard.
  v_placard jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 3,  'text','YARD TRAILER', 'fontSize', 4, 'bold', true),
      jsonb_build_object('id','trl','type','variable','xMm', 4, 'yMm', 11, 'token','trailer_code','fontSize', 5, 'bold', true),
      jsonb_build_object('id','car','type','variable','xMm', 4, 'yMm', 20, 'token','carrier_name','fontSize', 3),
      jsonb_build_object('id','slt','type','variable','xMm', 4, 'yMm', 26, 'token','slot_code','fontSize', 3, 'prefix','Slot: '),
      jsonb_build_object('id','sel','type','variable','xMm', 60,'yMm', 26, 'token','seal_in','fontSize', 3, 'prefix','Seal: '),
      jsonb_build_object('id','arr','type','variable','xMm', 4, 'yMm', 32, 'token','arrived_at','fontSize', 2, 'prefix','Arrived: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 38, 'token','visit_code','symbology','code128','heightMm', 20, 'moduleMm', 0.4, 'hri', true)
    )
  );
  -- Fixed signage for a parking position.
  v_slot jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 3, 'yMm', 2,  'text','YARD SLOT', 'fontSize', 3, 'bold', true),
      jsonb_build_object('id','cod','type','variable','xMm', 3, 'yMm', 8,  'token','slot_code','fontSize', 6, 'bold', true),
      jsonb_build_object('id','zon','type','variable','xMm', 3, 'yMm', 17, 'token','zone_kind','fontSize', 3),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 3, 'yMm', 21, 'token','slot_code','symbology','code128','heightMm', 12, 'moduleMm', 0.35, 'hri', true)
    )
  );
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'trailer_placard', 'wms.label.trailer_placard', 'Trailer Placard (WMS Yard)', 'zpl'::label_engine,
     '', v_placard, 'mm', 102, 76, true, true, _actor)
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
    (_org_id, NULL, 'yard_slot', 'wms.label.yard_slot', 'Yard Slot (WMS Yard)', 'zpl'::label_engine,
     '', v_slot, 'mm', 50, 38, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_yard_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_yard_label_templates(uuid, uuid) TO authenticated, service_role;

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
  PERFORM public.wms_seed_yard_label_templates(_org_id, _actor);
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) TO authenticated, service_role;

DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT org_id FROM public.label_templates WHERE template_key = 'wms.label.lpn'
  LOOP
    PERFORM public.wms_seed_yard_label_templates(r.org_id, NULL);
  END LOOP;
END $backfill$;