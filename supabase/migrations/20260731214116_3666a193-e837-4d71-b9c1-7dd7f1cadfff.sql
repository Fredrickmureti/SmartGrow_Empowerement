-- Phase 5.2 — open_loading_manifest resolves the trailer visit so the
-- no-show cascade has something to key on. Appointment link wins; a
-- trailer physically at the dock is the fallback.
CREATE OR REPLACE FUNCTION public.open_loading_manifest(
  p_dock_id uuid,
  p_carrier_id uuid DEFAULT NULL::uuid,
  p_planned_departure_at timestamptz DEFAULT NULL::timestamptz,
  p_appointment_id uuid DEFAULT NULL::uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dock record;
  v_appt record;
  v_visit_id uuid;
  v_id uuid;
  v_code text;
BEGIN
  SELECT id, organization_id, business_id, warehouse_id INTO v_dock
    FROM public.warehouse_docks WHERE id = p_dock_id;
  IF v_dock.id IS NULL THEN RAISE EXCEPTION 'dock % not found', p_dock_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_dock.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  IF p_appointment_id IS NOT NULL THEN
    SELECT * INTO v_appt FROM public.wms_dock_appointments WHERE id = p_appointment_id;
    IF v_appt.id IS NULL THEN RAISE EXCEPTION 'appointment % not found', p_appointment_id; END IF;
    IF v_appt.business_id <> v_dock.business_id THEN RAISE EXCEPTION 'appointment/dock business mismatch'; END IF;
    IF v_appt.dock_id <> p_dock_id THEN RAISE EXCEPTION 'appointment is for a different dock'; END IF;
    IF v_appt.appointment_type <> 'outbound' THEN RAISE EXCEPTION 'appointment is not outbound'; END IF;
    IF v_appt.state NOT IN ('scheduled','arrived','in_progress') THEN
      RAISE EXCEPTION 'appointment state % not allowed for opening manifest', v_appt.state;
    END IF;

    SELECT v.id INTO v_visit_id
      FROM public.wms_trailer_visits v
     WHERE v.appointment_id = p_appointment_id
       AND v.business_id = v_dock.business_id
       AND v.status NOT IN ('departed','no_show')
     ORDER BY v.arrived_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  IF v_visit_id IS NULL THEN
    SELECT v.id INTO v_visit_id
      FROM public.wms_trailer_visits v
     WHERE v.dock_id = p_dock_id
       AND v.business_id = v_dock.business_id
       AND v.status NOT IN ('departed','no_show')
     ORDER BY v.docked_at DESC NULLS LAST, v.arrived_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  v_code := 'LM-' || to_char(now(),'YYMMDD-HH24MISS');

  INSERT INTO public.wms_loading_manifests (
    organization_id, business_id, warehouse_id, dock_id, carrier_id,
    code, state, planned_departure_at, appointment_id, trailer_visit_id, created_by
  ) VALUES (
    v_dock.organization_id, v_dock.business_id, v_dock.warehouse_id, p_dock_id, p_carrier_id,
    v_code, 'loading', p_planned_departure_at, p_appointment_id, v_visit_id, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public.open_loading_manifest(uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.open_loading_manifest(uuid,uuid,timestamptz,uuid) TO authenticated, service_role;