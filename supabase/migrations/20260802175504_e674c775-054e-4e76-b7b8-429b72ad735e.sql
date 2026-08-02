-- Receiving audit, Phase 7 — putaway / quality-hold / quarantine label templates.
-- Preserve the existing seeder body under a base name, then re-declare the
-- canonical seeder as base + receiving templates.
DO $rename$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'wms_seed_default_label_templates'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'wms_seed_base_label_templates'
  ) THEN
    ALTER FUNCTION public.wms_seed_default_label_templates(uuid, uuid)
      RENAME TO wms_seed_base_label_templates;
  END IF;
END $rename$;

CREATE OR REPLACE FUNCTION public.wms_seed_receiving_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_putaway jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 3,  'text','PUT-AWAY', 'fontSize', 4, 'bold', true),
      jsonb_build_object('id','prd','type','variable','xMm', 4, 'yMm', 10, 'token','product_name','fontSize', 3),
      jsonb_build_object('id','qty','type','variable','xMm', 4, 'yMm', 16, 'token','quantity','fontSize', 3, 'prefix','Qty: '),
      jsonb_build_object('id','dst','type','variable','xMm', 4, 'yMm', 22, 'token','destination_bin','fontSize', 3, 'prefix','To: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 28, 'token','task_code','symbology','code128','heightMm', 18, 'moduleMm', 0.4, 'hri', true)
    )
  );
  v_hold jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 3,  'text','QUALITY HOLD', 'fontSize', 4, 'bold', true),
      jsonb_build_object('id','prd','type','variable','xMm', 4, 'yMm', 10, 'token','product_name','fontSize', 3),
      jsonb_build_object('id','lot','type','variable','xMm', 4, 'yMm', 16, 'token','lot_number','fontSize', 3, 'prefix','Lot: '),
      jsonb_build_object('id','rsn','type','variable','xMm', 4, 'yMm', 22, 'token','hold_reason','fontSize', 3, 'prefix','Reason: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 28, 'token','reference_code','symbology','code128','heightMm', 18, 'moduleMm', 0.4, 'hri', true)
    )
  );
  v_quar jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 3,  'text','QUARANTINE - DO NOT USE', 'fontSize', 4, 'bold', true),
      jsonb_build_object('id','prd','type','variable','xMm', 4, 'yMm', 10, 'token','product_name','fontSize', 3),
      jsonb_build_object('id','lot','type','variable','xMm', 4, 'yMm', 16, 'token','lot_number','fontSize', 3, 'prefix','Lot: '),
      jsonb_build_object('id','rsn','type','variable','xMm', 4, 'yMm', 22, 'token','hold_reason','fontSize', 3, 'prefix','Reason: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 28, 'token','reference_code','symbology','code128','heightMm', 18, 'moduleMm', 0.4, 'hri', true)
    )
  );
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'putaway', 'wms.label.putaway', 'Put-away Task (WMS)', 'zpl'::label_engine,
     '', v_putaway, 'mm', 102, 51, true, true, _actor)
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
    (_org_id, NULL, 'quality_hold', 'wms.label.quality_hold', 'Quality Hold (WMS)', 'zpl'::label_engine,
     '', v_hold, 'mm', 102, 51, true, true, _actor)
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
    (_org_id, NULL, 'quarantine', 'wms.label.quarantine', 'Quarantine (WMS)', 'zpl'::label_engine,
     '', v_quar, 'mm', 102, 51, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_receiving_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_receiving_label_templates(uuid, uuid) TO authenticated, service_role;

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
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) TO authenticated, service_role;

DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT org_id FROM public.label_templates WHERE template_key = 'wms.label.lpn'
  LOOP
    PERFORM public.wms_seed_receiving_label_templates(r.org_id, NULL);
  END LOOP;
END $backfill$;