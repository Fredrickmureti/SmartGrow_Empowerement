-- Fix: wms_trailer_visits stores the vehicle as trailer_ref (no vehicle_registration column).
CREATE OR REPLACE FUNCTION public.wms_manifest_bridge_delivery_notes(p_manifest_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_m        public.wms_loading_manifests%ROWTYPE;
  v_dn       record;
  v_ids      uuid[] := '{}';
  v_payload  jsonb;
  v_visit    record;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('linked', 0); END IF;

  SELECT tv.driver_name, tv.trailer_ref
    INTO v_visit
    FROM public.wms_trailer_visits tv
   WHERE tv.id = v_m.trailer_visit_id;

  FOR v_dn IN SELECT * FROM public.wms_manifest_delivery_notes(p_manifest_id) LOOP
    v_ids := v_ids || v_dn.delivery_note_id;

    UPDATE public.delivery_notes
       SET manifest_id = p_manifest_id, updated_at = now()
     WHERE id = v_dn.delivery_note_id
       AND manifest_id IS DISTINCT FROM p_manifest_id;

    IF v_dn.status IN ('pending', 'ready_to_dispatch') THEN
      v_payload := jsonb_strip_nulls(jsonb_build_object(
        'carrier_id',      v_m.carrier_id,
        'driver_name',     v_visit.driver_name,
        'vehicle_number',  v_visit.trailer_ref,
        'shipping_method', 'wms_manifest'
      ));
      BEGIN
        PERFORM public.dispatch_delivery_atomic(v_dn.delivery_note_id, auth.uid(), v_payload);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'wms_manifest_bridge_delivery_notes: could not dispatch delivery note %: %',
          v_dn.delivery_note_id, SQLERRM;
      END;
    END IF;
  END LOOP;

  IF array_length(v_ids, 1) = 1 THEN
    UPDATE public.wms_loading_manifests
       SET delivery_note_id = v_ids[1], updated_at = now()
     WHERE id = p_manifest_id AND delivery_note_id IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'linked', COALESCE(array_length(v_ids, 1), 0),
    'delivery_note_ids', to_jsonb(v_ids)
  );
END;
$function$;

-- Hook the bridge into the dispatched edge of the manifest FSM, right after
-- Phase A's ledger relief. Physical departure -> inventory relief -> customer
-- delivery dispatched, all in one transaction.
CREATE OR REPLACE FUNCTION public._wms_manifest_after_dispatch(p_manifest_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.wms_manifest_bridge_delivery_notes(p_manifest_id);
END;
$function$;

DO $do$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef(
    'public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb)'::regprocedure
  );

  IF position('_wms_manifest_after_dispatch' in v_def) = 0 THEN
    -- Insert the bridge call immediately after the Phase A relief loop,
    -- just before the manifest-level outbox emit.
    v_def := replace(
      v_def,
      '  PERFORM public._wms_emit_outbox(
    ''warehouse.manifest.'' || p_to_state::text,',
      '  IF p_to_state = ''dispatched'' THEN
    PERFORM public._wms_manifest_after_dispatch(p_manifest_id);
  END IF;

  PERFORM public._wms_emit_outbox(
    ''warehouse.manifest.'' || p_to_state::text,'
    );
    EXECUTE v_def;
  END IF;
END
$do$;