-- =====================================================================
-- ADR 0105 — Packaging Master, Phase 4b
--   SSCC event ledger, print audit, scan resolution, carton label
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Identity event ledger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_sscc_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL,
  sscc_id        uuid NOT NULL REFERENCES public.wms_sscc_registry(id) ON DELETE CASCADE,
  sscc           text NOT NULL,
  event_type     text NOT NULL,
  reason         text,
  copies         integer,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id       uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_sscc_events_type_chk CHECK (
    event_type IN ('allocated', 'label_printed', 'label_reprinted', 'voided', 'entity_bound')
  )
);

CREATE INDEX IF NOT EXISTS idx_wms_sscc_events_sscc
  ON public.wms_sscc_events (sscc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_sscc_events_business
  ON public.wms_sscc_events (business_id, created_at DESC);

GRANT SELECT ON public.wms_sscc_events TO authenticated;
GRANT ALL    ON public.wms_sscc_events TO service_role;
ALTER TABLE public.wms_sscc_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_sscc_events_select" ON public.wms_sscc_events FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE OR REPLACE FUNCTION public._wms_sscc_log(
  p_row public.wms_sscc_registry,
  p_event_type text,
  p_reason text DEFAULT NULL,
  p_copies integer DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.wms_sscc_events (
    business_id, sscc_id, sscc, event_type, reason, copies, payload, actor_id
  ) VALUES (
    p_row.business_id, p_row.id, p_row.sscc, p_event_type,
    NULLIF(p_reason, ''), p_copies, COALESCE(p_payload, '{}'::jsonb), auth.uid()
  );
END; $$;

REVOKE ALL ON FUNCTION public._wms_sscc_log(public.wms_sscc_registry, text, text, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_sscc_log(public.wms_sscc_registry, text, text, integer, jsonb)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2) Ledger writes inside allocate / void
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_sscc_allocate(
  p_business_id uuid,
  p_entity_type public.wms_sscc_entity,
  p_entity_id uuid DEFAULT NULL,
  p_count integer DEFAULT 1,
  p_options jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg    public.wms_gs1_config;
  v_opt    jsonb := COALESCE(p_options, '{}'::jsonb);
  v_count  integer := GREATEST(1, LEAST(COALESCE(p_count, 1), 500));
  v_serial bigint;
  v_sscc   text;
  v_rows   jsonb := '[]'::jsonb;
  v_row    public.wms_sscc_registry;
  v_i      integer;
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);

  IF p_entity_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.wms_sscc_registry
     WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND status = 'assigned'
     LIMIT 1;
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'reused', true,
        'sscc_list', jsonb_build_array(jsonb_build_object(
          'id', v_row.id, 'sscc', v_row.sscc, 'serial_reference', v_row.serial_reference))
      );
    END IF;
    v_count := 1;
  END IF;

  SELECT * INTO v_cfg FROM public.wms_gs1_config
   WHERE business_id = p_business_id FOR UPDATE;

  IF v_cfg.id IS NULL THEN
    RAISE EXCEPTION 'WMS_GS1_NOT_CONFIGURED: set a GS1 company prefix before issuing SSCCs';
  END IF;
  IF NOT v_cfg.is_enabled THEN
    RAISE EXCEPTION 'WMS_GS1_DISABLED: GS1 labelling is disabled for this business';
  END IF;

  FOR v_i IN 1..v_count LOOP
    UPDATE public.wms_gs1_config
       SET sscc_next_serial = sscc_next_serial + 1, updated_at = now()
     WHERE id = v_cfg.id
     RETURNING sscc_next_serial - 1 INTO v_serial;

    v_sscc := public.wms_sscc_build(v_cfg.company_prefix, v_cfg.extension_digit, v_serial);

    INSERT INTO public.wms_sscc_registry (
      organization_id, business_id, sscc, serial_reference, entity_type, entity_id,
      warehouse_id, packaging_type_id, payload, assigned_by
    ) VALUES (
      v_cfg.organization_id, p_business_id, v_sscc, v_serial, p_entity_type, p_entity_id,
      NULLIF(v_opt->>'warehouse_id','')::uuid,
      NULLIF(v_opt->>'packaging_type_id','')::uuid,
      COALESCE(v_opt->'payload', '{}'::jsonb),
      auth.uid()
    ) RETURNING * INTO v_row;

    PERFORM public._wms_sscc_log(
      v_row, 'allocated', NULL, NULL,
      jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id));

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'sscc', v_row.sscc, 'serial_reference', v_row.serial_reference));
  END LOOP;

  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      'wms.sscc.allocated', v_cfg.organization_id, p_business_id,
      'wms_sscc_registry', v_row.id,
      jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id,
                         'count', v_count, 'sscc_list', v_rows),
      'wms.sscc.allocated:' || v_row.id,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sscc event emission failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('reused', false, 'sscc_list', v_rows);
END; $$;

CREATE OR REPLACE FUNCTION public.wms_sscc_void(
  p_business_id uuid, p_sscc text, p_reason text DEFAULT NULL
) RETURNS public.wms_sscc_registry
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.wms_sscc_registry;
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);

  SELECT * INTO v_row FROM public.wms_sscc_registry
   WHERE business_id = p_business_id AND sscc = p_sscc FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'WMS_SSCC_NOT_FOUND: % is not registered for this business', p_sscc;
  END IF;
  IF v_row.status = 'voided' THEN
    RETURN v_row;
  END IF;

  UPDATE public.wms_sscc_registry
     SET status = 'voided', void_reason = NULLIF(p_reason,''),
         voided_at = now(), voided_by = auth.uid(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  PERFORM public._wms_sscc_log(v_row, 'voided', p_reason, NULL, '{}'::jsonb);

  RETURN v_row;
END; $$;

-- ---------------------------------------------------------------------
-- 3) wms_sscc_mark_printed — print / reprint audit (reason required)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_sscc_mark_printed(
  p_business_id uuid,
  p_sscc text,
  p_copies integer DEFAULT 1,
  p_is_reprint boolean DEFAULT false,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS public.wms_sscc_registry
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_sscc_registry;
  v_copies integer := GREATEST(1, LEAST(COALESCE(p_copies, 1), 100));
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);

  IF p_is_reprint AND COALESCE(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'WMS_SSCC_REPRINT_REASON_REQUIRED: a reason is required to reprint a label';
  END IF;

  SELECT * INTO v_row FROM public.wms_sscc_registry
   WHERE business_id = p_business_id AND sscc = p_sscc FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'WMS_SSCC_NOT_FOUND: % is not registered for this business', p_sscc;
  END IF;
  IF v_row.status = 'voided' THEN
    RAISE EXCEPTION 'WMS_SSCC_VOIDED: % has been voided and cannot be printed', p_sscc;
  END IF;

  UPDATE public.wms_sscc_registry
     SET printed_count = printed_count + v_copies,
         last_printed_at = now(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  PERFORM public._wms_sscc_log(
    v_row,
    CASE WHEN p_is_reprint THEN 'label_reprinted' ELSE 'label_printed' END,
    p_reason, v_copies, COALESCE(p_payload, '{}'::jsonb));

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_sscc_mark_printed(uuid, text, integer, boolean, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_sscc_mark_printed(uuid, text, integer, boolean, text, jsonb)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4) wms_resolve_sscc — scan a sealed handling unit back to its context
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_resolve_sscc(
  p_business_id uuid, p_code text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text := regexp_replace(COALESCE(p_code, ''), '[^0-9]', '', 'g');
  v_row  public.wms_sscc_registry;
  v_entity jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'WMS_GS1_AUTH: authentication required';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'WMS_GS1_FORBIDDEN: business access denied';
  END IF;

  -- Tolerate a scanned GS1 element string with a leading AI (00).
  IF length(v_code) = 20 AND left(v_code, 2) = '00' THEN
    v_code := right(v_code, 18);
  END IF;

  IF NOT public.wms_sscc_is_valid(v_code) THEN
    RETURN jsonb_build_object('found', false, 'reason', 'invalid_sscc', 'code', p_code);
  END IF;

  SELECT * INTO v_row FROM public.wms_sscc_registry
   WHERE business_id = p_business_id AND sscc = v_code;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'unknown_sscc', 'sscc', v_code);
  END IF;

  IF v_row.entity_id IS NOT NULL THEN
    IF v_row.entity_type = 'carton' THEN
      SELECT jsonb_build_object(
               'carton_id', c.id, 'wave_id', c.wave_id, 'sales_order_id', c.sales_order_id,
               'warehouse_id', c.warehouse_id, 'sealed_at', c.sealed_at,
               'weight_kg', c.weight_kg)
        INTO v_entity
        FROM public.wms_pack_cartons c WHERE c.id = v_row.entity_id;
    ELSIF v_row.entity_type IN ('lpn', 'pallet') THEN
      SELECT jsonb_build_object(
               'lpn_id', p.id, 'code', p.code, 'lpn_type', p.lpn_type,
               'status', p.status, 'warehouse_id', p.warehouse_id,
               'current_location_id', p.current_location_id)
        INTO v_entity
        FROM public.wms_license_plates p WHERE p.id = v_row.entity_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'sscc', v_row.sscc,
    'registry_id', v_row.id,
    'status', v_row.status,
    'entity_type', v_row.entity_type,
    'entity_id', v_row.entity_id,
    'packaging_type_id', v_row.packaging_type_id,
    'warehouse_id', v_row.warehouse_id,
    'entity', v_entity
  );
END; $$;

REVOKE ALL ON FUNCTION public.wms_resolve_sscc(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_resolve_sscc(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5) Carton / handling-unit label template (wms.label.carton)
--     Re-declares the seeder with the new template added.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_seed_default_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
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
  -- Carton / handling unit: SSCC is the primary identifier (GS1 AI 00).
  v_carton_doc jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl', 'type','text',    'xMm', 4, 'yMm', 4,  'text','HANDLING UNIT', 'fontSize', 3, 'bold', true),
      jsonb_build_object('id','pkg', 'type','variable','xMm', 4, 'yMm', 9,  'token','packaging_name','fontSize', 3),
      jsonb_build_object('id','ord', 'type','variable','xMm', 60,'yMm', 9,  'token','order_number','fontSize', 3, 'prefix','Order '),
      jsonb_build_object('id','seq', 'type','variable','xMm', 4, 'yMm', 15, 'token','carton_sequence','fontSize', 3, 'prefix','Carton '),
      jsonb_build_object('id','wt',  'type','variable','xMm', 60,'yMm', 15, 'token','gross_weight','fontSize', 3, 'prefix','Gross: '),
      jsonb_build_object('id','bc',  'type','barcode', 'xMm', 4, 'yMm', 22, 'token','barcode_data','symbology','code128','heightMm', 26, 'moduleMm', 0.4, 'hri', false),
      jsonb_build_object('id','hri', 'type','variable','xMm', 4, 'yMm', 52, 'token','sscc_hri','fontSize', 3, 'bold', true),
      jsonb_build_object('id','wh',  'type','variable','xMm', 4, 'yMm', 60, 'token','warehouse_name','fontSize', 2),
      jsonb_build_object('id','ts',  'type','variable','xMm', 4, 'yMm', 66, 'token','printed_at','fontSize', 2, 'prefix','Printed: ')
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
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();

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
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();

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
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();

  -- Carton / handling unit (SSCC)
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'carton', 'wms.label.carton', 'Carton / Handling Unit (WMS)', 'zpl'::label_engine,
     '', v_carton_doc, 'mm', 102, 76, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();
END $fn$;

GRANT EXECUTE ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) TO authenticated, service_role;

-- Backfill the carton template for organizations already seeded.
DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT org_id FROM public.label_templates WHERE template_key = 'wms.label.lpn'
  LOOP
    PERFORM public.wms_seed_default_label_templates(r.org_id, NULL);
  END LOOP;
END $backfill$;