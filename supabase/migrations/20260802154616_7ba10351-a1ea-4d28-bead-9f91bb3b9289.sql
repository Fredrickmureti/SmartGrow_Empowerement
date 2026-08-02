-- Phase 5 (ADR 0105 §7): handling units reference the Packaging Master.

ALTER TABLE public.wms_license_plates
  ADD COLUMN IF NOT EXISTS packaging_type_id uuid REFERENCES public.wms_packaging_types(id);

CREATE INDEX IF NOT EXISTS idx_wms_license_plates_packaging_type
  ON public.wms_license_plates (packaging_type_id)
  WHERE packaging_type_id IS NOT NULL;

-- `wms_lpn_type` survives only as a coarse facet DERIVED from packaging class.
CREATE OR REPLACE FUNCTION public.wms_packaging_class_to_lpn_type(_class public.wms_packaging_class)
RETURNS public.wms_lpn_type
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE _class
    WHEN 'pallet'    THEN 'pallet'::public.wms_lpn_type
    WHEN 'crate'     THEN 'pallet'::public.wms_lpn_type
    WHEN 'tote'      THEN 'tote'::public.wms_lpn_type
    WHEN 'carton'    THEN 'carton'::public.wms_lpn_type
    WHEN 'envelope'  THEN 'carton'::public.wms_lpn_type
    WHEN 'tube'      THEN 'carton'::public.wms_lpn_type
    WHEN 'insulated' THEN 'carton'::public.wms_lpn_type
    ELSE 'other'::public.wms_lpn_type
  END
$$;

GRANT EXECUTE ON FUNCTION public.wms_packaging_class_to_lpn_type(public.wms_packaging_class) TO authenticated;

-- Assign packaging to a handling unit. RPC-only (ADR 0102 §2), business
-- guarded, optimistic-concurrency checked, audited on wms_lpn_events.
CREATE OR REPLACE FUNCTION public.wms_lpn_set_packaging(
  _lpn_id uuid,
  _packaging_type_id uuid,
  _expected_version integer DEFAULT NULL
)
RETURNS public.wms_license_plates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plate public.wms_license_plates;
  v_pack  public.wms_packaging_types;
BEGIN
  SELECT * INTO v_plate FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF v_plate.id IS NULL THEN
    RAISE EXCEPTION 'WMS_LPN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_plate.business_id) THEN
    RAISE EXCEPTION 'WMS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_plate.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'WMS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF _expected_version IS NOT NULL AND v_plate.row_version IS DISTINCT FROM _expected_version THEN
    RAISE EXCEPTION 'WMS_LPN_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_pack FROM public.wms_packaging_types WHERE id = _packaging_type_id;
  IF v_pack.id IS NULL OR v_pack.business_id IS DISTINCT FROM v_plate.business_id THEN
    RAISE EXCEPTION 'WMS_PACKAGING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_pack.lifecycle_status = 'retired' THEN
    RAISE EXCEPTION 'WMS_PACKAGING_RETIRED' USING ERRCODE = '22023';
  END IF;

  -- Idempotent: re-assigning the same packaging is a no-op (no version bump,
  -- no duplicate audit row) so a replayed offline action stays safe.
  IF v_plate.packaging_type_id IS NOT DISTINCT FROM _packaging_type_id THEN
    RETURN v_plate;
  END IF;

  UPDATE public.wms_license_plates
     SET packaging_type_id = _packaging_type_id,
         lpn_type = public.wms_packaging_class_to_lpn_type(v_pack.packaging_class),
         row_version = COALESCE(row_version, 0) + 1,
         updated_at = now()
   WHERE id = _lpn_id
  RETURNING * INTO v_plate;

  INSERT INTO public.wms_lpn_events (
    business_id, branch_id, organization_id, warehouse_id, lpn_id,
    event_type, actor_id, payload
  ) VALUES (
    v_plate.business_id, v_plate.branch_id, v_plate.organization_id,
    v_plate.warehouse_id, v_plate.id,
    'packaging_assigned', auth.uid(),
    jsonb_build_object(
      'packaging_type_id', v_pack.id,
      'packaging_code', v_pack.code,
      'packaging_class', v_pack.packaging_class,
      'lpn_type', v_plate.lpn_type
    )
  );

  RETURN v_plate;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_lpn_set_packaging(uuid, uuid, integer) TO authenticated;

-- Pack station stamps packaging on the carton; its shipment plate inherits it.
CREATE OR REPLACE FUNCTION public._wms_pack_carton_propagate_packaging()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class public.wms_packaging_class;
BEGIN
  IF NEW.packaging_type_id IS NULL OR NEW.shipment_lpn_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.packaging_type_id IS NOT DISTINCT FROM NEW.packaging_type_id THEN
    RETURN NEW;
  END IF;

  SELECT packaging_class INTO v_class
    FROM public.wms_packaging_types WHERE id = NEW.packaging_type_id;
  IF v_class IS NULL THEN RETURN NEW; END IF;

  UPDATE public.wms_license_plates
     SET packaging_type_id = NEW.packaging_type_id,
         lpn_type = public.wms_packaging_class_to_lpn_type(v_class),
         row_version = COALESCE(row_version, 0) + 1,
         updated_at = now()
   WHERE id = NEW.shipment_lpn_id
     AND packaging_type_id IS DISTINCT FROM NEW.packaging_type_id;

  IF FOUND THEN
    INSERT INTO public.wms_lpn_events (
      business_id, branch_id, organization_id, warehouse_id, lpn_id,
      event_type, actor_id, payload
    ) VALUES (
      NEW.business_id, NEW.branch_id, NEW.organization_id, NEW.warehouse_id,
      NEW.shipment_lpn_id, 'packaging_assigned', auth.uid(),
      jsonb_build_object(
        'packaging_type_id', NEW.packaging_type_id,
        'source', 'pack_carton',
        'carton_id', NEW.id
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_pack_carton_propagate_packaging ON public.wms_pack_cartons;
CREATE TRIGGER trg_wms_pack_carton_propagate_packaging
AFTER INSERT OR UPDATE OF packaging_type_id ON public.wms_pack_cartons
FOR EACH ROW EXECUTE FUNCTION public._wms_pack_carton_propagate_packaging();

-- `pack.carton` scan intent resolver: an SSCC-18, a GS1 (00) element string or
-- a plate code all resolve back to one handling unit.
CREATE OR REPLACE FUNCTION public.wms_resolve_carton_scan(
  p_business_id uuid,
  p_code text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code   text := regexp_replace(COALESCE(p_code, ''), '\s', '', 'g');
  v_digits text;
  v_lpn_id uuid;
  v_sscc   text;
  v_result jsonb;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'WMS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_code = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_scan');
  END IF;

  -- GS1 AI (00) prefix, if the caller passed a raw element string.
  v_digits := regexp_replace(v_code, '^\(?00\)?', '');
  v_digits := CASE WHEN v_digits ~ '^[0-9]{18}$' THEN v_digits ELSE NULL END;

  IF v_digits IS NOT NULL THEN
    SELECT r.entity_id, r.sscc INTO v_lpn_id, v_sscc
      FROM public.wms_sscc_registry r
     WHERE r.business_id = p_business_id
       AND r.sscc = v_digits
     LIMIT 1;
    IF v_sscc IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unknown_sscc', 'code', v_digits);
    END IF;
  END IF;

  -- Carton entity ids point at wms_pack_cartons; map them to the shipment plate.
  IF v_lpn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.wms_license_plates WHERE id = v_lpn_id
  ) THEN
    SELECT c.shipment_lpn_id INTO v_lpn_id
      FROM public.wms_pack_cartons c WHERE c.id = v_lpn_id;
  END IF;

  IF v_lpn_id IS NULL THEN
    SELECT id INTO v_lpn_id
      FROM public.wms_license_plates
     WHERE business_id = p_business_id
       AND upper(code) = upper(v_code)
     LIMIT 1;
  END IF;

  IF v_lpn_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_code', 'code', v_code);
  END IF;

  SELECT jsonb_build_object(
           'ok', true,
           'sscc', v_sscc,
           'lpn', jsonb_build_object(
             'id', l.id,
             'code', l.code,
             'status', l.status,
             'lpn_type', l.lpn_type,
             'location_id', l.current_location_id,
             'sealed_at', l.sealed_at,
             'row_version', l.row_version
           ),
           'packaging', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', p.id, 'code', p.code, 'name', p.name,
             'packaging_class', p.packaging_class,
             'lifecycle_status', p.lifecycle_status
           ) END,
           'carton', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', c.id, 'sealed_at', c.sealed_at, 'weight_kg', c.weight_kg,
             'sales_order_id', c.sales_order_id
           ) END
         )
    INTO v_result
    FROM public.wms_license_plates l
    LEFT JOIN public.wms_packaging_types p ON p.id = l.packaging_type_id
    LEFT JOIN public.wms_pack_cartons c ON c.shipment_lpn_id = l.id
   WHERE l.id = v_lpn_id
     AND l.business_id = p_business_id
   LIMIT 1;

  RETURN COALESCE(v_result, jsonb_build_object('ok', false, 'reason', 'unknown_code', 'code', v_code));
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_resolve_carton_scan(uuid, text) TO authenticated;