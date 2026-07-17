
-- Phase 6: Dock scheduling & appointments
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.wms_dock_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id),
  dock_id uuid NOT NULL REFERENCES public.warehouse_docks(id),
  appointment_type text NOT NULL CHECK (appointment_type IN ('inbound','outbound')),
  carrier_id uuid REFERENCES public.carriers(id),
  reference text,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','arrived','in_progress','completed','cancelled','no_show')),
  arrived_at timestamptz,
  completed_at timestamptz,
  cancelled_reason text,
  is_sample_data boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_dock_appointments_window_chk CHECK (window_end > window_start),
  -- No two active appointments overlap on the same dock
  CONSTRAINT wms_dock_appointments_no_overlap EXCLUDE USING gist (
    dock_id WITH =,
    tstzrange(window_start, window_end, '[)') WITH &&
  ) WHERE (state NOT IN ('cancelled','no_show'))
);

CREATE INDEX idx_wms_dock_appointments_dock_window
  ON public.wms_dock_appointments (dock_id, window_start);
CREATE INDEX idx_wms_dock_appointments_business_state
  ON public.wms_dock_appointments (business_id, state);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_dock_appointments TO authenticated;
GRANT ALL ON public.wms_dock_appointments TO service_role;

ALTER TABLE public.wms_dock_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_dock_appointments business scoped select"
  ON public.wms_dock_appointments FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_dock_appointments business scoped write"
  ON public.wms_dock_appointments FOR ALL
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER wms_dock_appointments_updated_at
  BEFORE UPDATE ON public.wms_dock_appointments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- FK additions
ALTER TABLE public.wms_loading_manifests
  ADD COLUMN appointment_id uuid REFERENCES public.wms_dock_appointments(id);

ALTER TABLE public.goods_receipts
  ADD COLUMN appointment_id uuid REFERENCES public.wms_dock_appointments(id);

-- ============================================================
-- RPCs
-- ============================================================
CREATE OR REPLACE FUNCTION public.schedule_dock_appointment(
  p_dock_id uuid,
  p_type text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_carrier_id uuid DEFAULT NULL,
  p_reference text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dock record;
  v_id uuid;
BEGIN
  SELECT id, organization_id, business_id, warehouse_id INTO v_dock
    FROM public.warehouse_docks WHERE id = p_dock_id;
  IF v_dock.id IS NULL THEN RAISE EXCEPTION 'dock % not found', p_dock_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_dock.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_type NOT IN ('inbound','outbound') THEN RAISE EXCEPTION 'invalid appointment_type %', p_type; END IF;
  IF p_window_end <= p_window_start THEN RAISE EXCEPTION 'window_end must be after window_start'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.wms_dock_appointments
    WHERE dock_id = p_dock_id
      AND state NOT IN ('cancelled','no_show')
      AND tstzrange(window_start, window_end, '[)') && tstzrange(p_window_start, p_window_end, '[)')
  ) THEN
    RAISE EXCEPTION 'dock % is already booked in the requested window', p_dock_id;
  END IF;

  INSERT INTO public.wms_dock_appointments (
    organization_id, business_id, warehouse_id, dock_id,
    appointment_type, carrier_id, reference, window_start, window_end, created_by
  ) VALUES (
    v_dock.organization_id, v_dock.business_id, v_dock.warehouse_id, p_dock_id,
    p_type, p_carrier_id, p_reference, p_window_start, p_window_end, auth.uid()
  ) RETURNING id INTO v_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_dock.organization_id, v_dock.warehouse_id, 'warehouse.appointment.scheduled',
      'wms_dock_appointment', v_id,
      jsonb_build_object('appointment_id', v_id, 'business_id', v_dock.business_id,
        'dock_id', p_dock_id, 'type', p_type,
        'window_start', p_window_start, 'window_end', p_window_end),
      'wms.appointment.scheduled:' || v_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'appointment scheduled outbox emit failed: %', SQLERRM; END;

  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public._appt_transition(
  p_appointment_id uuid,
  p_from text[],
  p_to text,
  p_event text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_appt record;
BEGIN
  SELECT * INTO v_appt FROM public.wms_dock_appointments WHERE id = p_appointment_id FOR UPDATE;
  IF v_appt.id IS NULL THEN RAISE EXCEPTION 'appointment % not found', p_appointment_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_appt.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF NOT (v_appt.state = ANY(p_from)) THEN
    RAISE EXCEPTION 'cannot transition appointment from % to %', v_appt.state, p_to;
  END IF;

  UPDATE public.wms_dock_appointments
    SET state = p_to,
        arrived_at   = CASE WHEN p_to='arrived'    AND arrived_at   IS NULL THEN now() ELSE arrived_at   END,
        completed_at = CASE WHEN p_to='completed'  AND completed_at IS NULL THEN now() ELSE completed_at END,
        cancelled_reason = CASE WHEN p_to='cancelled' THEN COALESCE(p_reason, cancelled_reason) ELSE cancelled_reason END
    WHERE id = p_appointment_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_appt.organization_id, v_appt.warehouse_id, p_event,
      'wms_dock_appointment', p_appointment_id,
      jsonb_build_object('appointment_id', p_appointment_id, 'business_id', v_appt.business_id,
        'dock_id', v_appt.dock_id, 'state', p_to),
      'wms.appointment.' || p_to || ':' || p_appointment_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'appointment % outbox emit failed: %', p_to, SQLERRM; END;
END; $$;

CREATE OR REPLACE FUNCTION public.mark_appointment_arrived(p_appointment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public._appt_transition(p_appointment_id, ARRAY['scheduled'], 'arrived', 'warehouse.appointment.arrived'); END; $$;

CREATE OR REPLACE FUNCTION public.start_appointment(p_appointment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public._appt_transition(p_appointment_id, ARRAY['arrived','scheduled'], 'in_progress', 'warehouse.appointment.in_progress'); END; $$;

CREATE OR REPLACE FUNCTION public.complete_dock_appointment(p_appointment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public._appt_transition(p_appointment_id, ARRAY['arrived','in_progress'], 'completed', 'warehouse.appointment.completed'); END; $$;

CREATE OR REPLACE FUNCTION public.cancel_dock_appointment(p_appointment_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public._appt_transition(p_appointment_id, ARRAY['scheduled','arrived','in_progress'], 'cancelled', 'warehouse.appointment.cancelled', p_reason); END; $$;

-- Replace open_loading_manifest to accept optional appointment_id
CREATE OR REPLACE FUNCTION public.open_loading_manifest(
  p_dock_id uuid,
  p_carrier_id uuid DEFAULT NULL,
  p_planned_departure_at timestamptz DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dock record;
  v_appt record;
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
  END IF;

  v_code := 'LM-' || to_char(now(),'YYMMDD-HH24MISS');

  INSERT INTO public.wms_loading_manifests (
    organization_id, business_id, warehouse_id, dock_id, carrier_id,
    code, state, planned_departure_at, appointment_id, created_by
  ) VALUES (
    v_dock.organization_id, v_dock.business_id, v_dock.warehouse_id, p_dock_id, p_carrier_id,
    v_code, 'loading', p_planned_departure_at, p_appointment_id, auth.uid()
  )
  RETURNING id INTO v_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_dock.organization_id, v_dock.warehouse_id, 'warehouse.manifest.opened',
      'wms_loading_manifest', v_id,
      jsonb_build_object('manifest_id', v_id, 'business_id', v_dock.business_id, 'dock_id', p_dock_id, 'code', v_code, 'appointment_id', p_appointment_id),
      'wms.manifest.opened:' || v_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'manifest opened outbox emit failed: %', SQLERRM; END;

  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.bind_goods_receipt_appointment(
  p_receipt_id uuid,
  p_appointment_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_receipt record;
  v_appt record;
BEGIN
  SELECT id, business_id, warehouse_id, status INTO v_receipt
    FROM public.goods_receipts WHERE id = p_receipt_id;
  IF v_receipt.id IS NULL THEN RAISE EXCEPTION 'receipt % not found', p_receipt_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_receipt.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  SELECT id, business_id, warehouse_id, appointment_type, state INTO v_appt
    FROM public.wms_dock_appointments WHERE id = p_appointment_id;
  IF v_appt.id IS NULL THEN RAISE EXCEPTION 'appointment % not found', p_appointment_id; END IF;
  IF v_appt.business_id <> v_receipt.business_id THEN RAISE EXCEPTION 'appointment/receipt business mismatch'; END IF;
  IF v_appt.appointment_type <> 'inbound' THEN RAISE EXCEPTION 'appointment is not inbound'; END IF;
  IF v_appt.state NOT IN ('scheduled','arrived','in_progress','completed') THEN
    RAISE EXCEPTION 'appointment state % not allowed for binding', v_appt.state;
  END IF;

  UPDATE public.goods_receipts SET appointment_id = p_appointment_id, updated_at = now() WHERE id = p_receipt_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.schedule_dock_appointment(uuid, text, timestamptz, timestamptz, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_appointment_arrived(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_appointment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_dock_appointment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_dock_appointment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bind_goods_receipt_appointment(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_loading_manifest(uuid, uuid, timestamptz, uuid) TO authenticated;
