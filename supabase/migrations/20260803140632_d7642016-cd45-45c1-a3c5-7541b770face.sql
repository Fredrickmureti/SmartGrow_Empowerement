-- =====================================================================
-- Dock Scheduling & Yard Operations — Phases A–D
-- =====================================================================

-- ---------------------------------------------------------------------
-- Phase A — appointment becomes a first-class object
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_dock_appointments
  ADD COLUMN IF NOT EXISTS appointment_no text,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS party_contact_id uuid,
  ADD COLUMN IF NOT EXISTS trailer_ref text,
  ADD COLUMN IF NOT EXISTS tractor_ref text,
  ADD COLUMN IF NOT EXISTS driver_name text,
  ADD COLUMN IF NOT EXISTS driver_phone text,
  ADD COLUMN IF NOT EXISTS scheduled_departure timestamptz,
  ADD COLUMN IF NOT EXISTS departed_at timestamptz,
  ADD COLUMN IF NOT EXISTS qr_token text;

DO $$ BEGIN
  ALTER TABLE public.wms_dock_appointments
    ADD CONSTRAINT wms_dock_appt_priority_chk
    CHECK (priority IN ('low','normal','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.wms_dock_appointments
    ADD CONSTRAINT wms_dock_appt_party_fk
    FOREIGN KEY (party_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wms_dock_appt_no
  ON public.wms_dock_appointments(organization_id, appointment_no)
  WHERE appointment_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wms_dock_appt_qr
  ON public.wms_dock_appointments(qr_token) WHERE qr_token IS NOT NULL;

CREATE OR REPLACE FUNCTION public._next_dock_appointment_no(p_org uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_num int;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(appointment_no, '^APT-', ''), '')::int), 0) + 1
    INTO v_num FROM public.wms_dock_appointments
   WHERE organization_id = p_org AND appointment_no ~ '^APT-[0-9]+$';
  RETURN 'APT-' || LPAD(v_num::text, 6, '0');
END $$;

-- Backfill numbers + QR tokens for pre-existing rows.
UPDATE public.wms_dock_appointments a
   SET appointment_no = 'APT-' || LPAD(s.rn::text, 6, '0')
  FROM (
    SELECT id, organization_id,
           row_number() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS rn
      FROM public.wms_dock_appointments WHERE appointment_no IS NULL
  ) s
 WHERE a.id = s.id;

UPDATE public.wms_dock_appointments
   SET qr_token = encode(gen_random_bytes(16), 'hex')
 WHERE qr_token IS NULL;

-- Typed link between an appointment and the documents it serves.
CREATE TABLE IF NOT EXISTS public.wms_appointment_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  appointment_id uuid NOT NULL REFERENCES public.wms_dock_appointments(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN (
    'purchase_order','goods_receipt','sales_order','delivery_note',
    'shipment','stock_transfer','return_order','bill')),
  doc_id uuid NOT NULL,
  doc_number text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_appt_docs_unique UNIQUE (appointment_id, doc_type, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_appt_docs_appt ON public.wms_appointment_documents(appointment_id);
CREATE INDEX IF NOT EXISTS idx_wms_appt_docs_doc ON public.wms_appointment_documents(doc_type, doc_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_appointment_documents TO authenticated;
GRANT ALL ON public.wms_appointment_documents TO service_role;

ALTER TABLE public.wms_appointment_documents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "wms_appt_docs_biz_read" ON public.wms_appointment_documents
    FOR SELECT TO authenticated
    USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "wms_appt_docs_biz_write" ON public.wms_appointment_documents
    FOR ALL TO authenticated
    USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()))
    WITH CHECK (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_appt_docs_updated_at
    BEFORE UPDATE ON public.wms_appointment_documents
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Phase B — dock capability model
-- ---------------------------------------------------------------------
ALTER TABLE public.warehouse_docks
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS operating_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS default_turn_minutes integer NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS public.wms_dock_downtime (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  dock_id uuid NOT NULL REFERENCES public.warehouse_docks(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'maintenance'
    CHECK (reason IN ('maintenance','repair','blocked','closed','other')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_dock_downtime_window_chk CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS idx_wms_dock_downtime_dock
  ON public.wms_dock_downtime(dock_id, window_start);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_dock_downtime TO authenticated;
GRANT ALL ON public.wms_dock_downtime TO service_role;

ALTER TABLE public.wms_dock_downtime ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "wms_dock_downtime_biz_read" ON public.wms_dock_downtime
    FOR SELECT TO authenticated
    USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "wms_dock_downtime_biz_write" ON public.wms_dock_downtime
    FOR ALL TO authenticated
    USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()))
    WITH CHECK (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_dock_downtime_updated_at
    BEFORE UPDATE ON public.wms_dock_downtime
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Feasibility: capability match, downtime, overlap. Returns list of reasons.
CREATE OR REPLACE FUNCTION public.check_dock_feasibility(
  p_dock_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_requirements jsonb DEFAULT '{}'::jsonb,
  p_exclude_appointment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_dock public.warehouse_docks;
  v_reasons text[] := ARRAY[]::text[];
  v_req_weight numeric;
  v_req_length numeric;
  v_req_height numeric;
BEGIN
  SELECT * INTO v_dock FROM public.warehouse_docks WHERE id = p_dock_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('feasible', false, 'reasons', to_jsonb(ARRAY['dock not found']));
  END IF;

  IF NOT v_dock.is_active THEN
    v_reasons := v_reasons || 'dock is inactive';
  END IF;

  IF p_window_end <= p_window_start THEN
    v_reasons := v_reasons || 'window end must be after window start';
  END IF;

  IF COALESCE((p_requirements->>'refrigerated')::boolean, false)
     AND NOT COALESCE((v_dock.capabilities->>'refrigerated')::boolean, false) THEN
    v_reasons := v_reasons || 'dock is not refrigerated';
  END IF;

  IF COALESCE((p_requirements->>'hazmat')::boolean, false)
     AND NOT COALESCE((v_dock.capabilities->>'hazmat')::boolean, false) THEN
    v_reasons := v_reasons || 'dock does not accept hazardous goods';
  END IF;

  IF COALESCE((p_requirements->>'tail_lift')::boolean, false)
     AND NOT COALESCE((v_dock.capabilities->>'tail_lift')::boolean, false) THEN
    v_reasons := v_reasons || 'dock has no tail lift';
  END IF;

  v_req_weight := NULLIF(p_requirements->>'weight_kg', '')::numeric;
  IF v_req_weight IS NOT NULL
     AND NULLIF(v_dock.capabilities->>'max_weight_kg','') IS NOT NULL
     AND v_req_weight > (v_dock.capabilities->>'max_weight_kg')::numeric THEN
    v_reasons := v_reasons || 'exceeds dock weight limit';
  END IF;

  v_req_length := NULLIF(p_requirements->>'length_m', '')::numeric;
  IF v_req_length IS NOT NULL
     AND NULLIF(v_dock.capabilities->>'max_length_m','') IS NOT NULL
     AND v_req_length > (v_dock.capabilities->>'max_length_m')::numeric THEN
    v_reasons := v_reasons || 'exceeds dock length limit';
  END IF;

  v_req_height := NULLIF(p_requirements->>'height_m', '')::numeric;
  IF v_req_height IS NOT NULL
     AND NULLIF(v_dock.capabilities->>'max_height_m','') IS NOT NULL
     AND v_req_height > (v_dock.capabilities->>'max_height_m')::numeric THEN
    v_reasons := v_reasons || 'exceeds dock height limit';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wms_dock_downtime d
     WHERE d.dock_id = p_dock_id
       AND tstzrange(d.window_start, d.window_end, '[)') && tstzrange(p_window_start, p_window_end, '[)')
  ) THEN
    v_reasons := v_reasons || 'dock is out of service during this window';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wms_dock_appointments a
     WHERE a.dock_id = p_dock_id
       AND a.state NOT IN ('cancelled','no_show','completed')
       AND (p_exclude_appointment_id IS NULL OR a.id <> p_exclude_appointment_id)
       AND tstzrange(a.window_start, a.window_end, '[)') && tstzrange(p_window_start, p_window_end, '[)')
  ) THEN
    v_reasons := v_reasons || 'dock is already booked in this window';
  END IF;

  RETURN jsonb_build_object(
    'feasible', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'dock_id', p_dock_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.check_dock_feasibility(uuid,timestamptz,timestamptz,jsonb,uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- Phase A (cont.) — richer scheduling RPC
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.schedule_dock_appointment(uuid,text,timestamptz,timestamptz,uuid,text);

CREATE OR REPLACE FUNCTION public.schedule_dock_appointment(
  p_dock_id uuid,
  p_type text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_carrier_id uuid DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_party_contact_id uuid DEFAULT NULL,
  p_trailer_ref text DEFAULT NULL,
  p_tractor_ref text DEFAULT NULL,
  p_driver_name text DEFAULT NULL,
  p_driver_phone text DEFAULT NULL,
  p_scheduled_departure timestamptz DEFAULT NULL,
  p_requirements jsonb DEFAULT '{}'::jsonb,
  p_documents jsonb DEFAULT '[]'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_dock record;
  v_id uuid;
  v_feasible jsonb;
  v_doc jsonb;
  v_no text;
  v_qr text;
BEGIN
  SELECT id, organization_id, business_id, warehouse_id INTO v_dock
    FROM public.warehouse_docks WHERE id = p_dock_id;
  IF v_dock.id IS NULL THEN RAISE EXCEPTION 'dock % not found', p_dock_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_dock.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_type NOT IN ('inbound','outbound') THEN RAISE EXCEPTION 'invalid appointment_type %', p_type; END IF;
  IF p_priority NOT IN ('low','normal','high','critical') THEN RAISE EXCEPTION 'invalid priority %', p_priority; END IF;

  v_feasible := public.check_dock_feasibility(p_dock_id, p_window_start, p_window_end, COALESCE(p_requirements, '{}'::jsonb), NULL);
  IF NOT (v_feasible->>'feasible')::boolean THEN
    RAISE EXCEPTION 'dock not feasible: %', array_to_string(
      ARRAY(SELECT jsonb_array_elements_text(v_feasible->'reasons')), '; ');
  END IF;

  v_no := public._next_dock_appointment_no(v_dock.organization_id);
  v_qr := encode(gen_random_bytes(16), 'hex');

  INSERT INTO public.wms_dock_appointments (
    organization_id, business_id, warehouse_id, dock_id,
    appointment_type, carrier_id, reference, window_start, window_end, created_by,
    appointment_no, priority, party_contact_id, trailer_ref, tractor_ref,
    driver_name, driver_phone, scheduled_departure, qr_token
  ) VALUES (
    v_dock.organization_id, v_dock.business_id, v_dock.warehouse_id, p_dock_id,
    p_type, p_carrier_id, p_reference, p_window_start, p_window_end, auth.uid(),
    v_no, p_priority, p_party_contact_id, p_trailer_ref, p_tractor_ref,
    p_driver_name, p_driver_phone, p_scheduled_departure, v_qr
  ) RETURNING id INTO v_id;

  IF p_documents IS NOT NULL AND jsonb_typeof(p_documents) = 'array' THEN
    FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents) LOOP
      INSERT INTO public.wms_appointment_documents (
        organization_id, business_id, appointment_id, doc_type, doc_id, doc_number, created_by
      ) VALUES (
        v_dock.organization_id, v_dock.business_id, v_id,
        v_doc->>'doc_type', (v_doc->>'doc_id')::uuid, v_doc->>'doc_number', auth.uid()
      ) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_dock.organization_id, v_dock.warehouse_id, 'warehouse.appointment.scheduled',
      'wms_dock_appointment', v_id,
      jsonb_build_object('appointment_id', v_id, 'appointment_no', v_no,
        'business_id', v_dock.business_id, 'dock_id', p_dock_id, 'type', p_type,
        'priority', p_priority, 'documents', COALESCE(p_documents, '[]'::jsonb),
        'window_start', p_window_start, 'window_end', p_window_end),
      'wms.appointment.scheduled:' || v_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'appointment scheduled outbox emit failed: %', SQLERRM; END;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.schedule_dock_appointment(uuid,text,timestamptz,timestamptz,uuid,text,text,uuid,text,text,text,text,timestamptz,jsonb,jsonb) TO authenticated;

-- Reschedule (drag-and-drop on the planner board).
CREATE OR REPLACE FUNCTION public.reschedule_dock_appointment(
  p_appointment_id uuid,
  p_dock_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_appt public.wms_dock_appointments;
  v_dock record;
  v_feasible jsonb;
BEGIN
  SELECT * INTO v_appt FROM public.wms_dock_appointments WHERE id = p_appointment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'appointment not found'; END IF;
  IF NOT user_can_access_business(auth.uid(), v_appt.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_appt.state NOT IN ('scheduled','arrived') THEN
    RAISE EXCEPTION 'cannot reschedule an appointment in state %', v_appt.state;
  END IF;

  SELECT id, warehouse_id INTO v_dock FROM public.warehouse_docks WHERE id = p_dock_id;
  IF v_dock.id IS NULL THEN RAISE EXCEPTION 'dock not found'; END IF;
  IF v_dock.warehouse_id <> v_appt.warehouse_id THEN RAISE EXCEPTION 'dock/warehouse mismatch'; END IF;

  v_feasible := public.check_dock_feasibility(p_dock_id, p_window_start, p_window_end, '{}'::jsonb, p_appointment_id);
  IF NOT (v_feasible->>'feasible')::boolean THEN
    RAISE EXCEPTION 'dock not feasible: %', array_to_string(
      ARRAY(SELECT jsonb_array_elements_text(v_feasible->'reasons')), '; ');
  END IF;

  UPDATE public.wms_dock_appointments
     SET dock_id = p_dock_id, window_start = p_window_start, window_end = p_window_end
   WHERE id = p_appointment_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_appt.organization_id, v_appt.warehouse_id, 'warehouse.appointment.rescheduled',
      'wms_dock_appointment', p_appointment_id,
      jsonb_build_object('appointment_id', p_appointment_id, 'dock_id', p_dock_id,
        'window_start', p_window_start, 'window_end', p_window_end),
      'wms.appointment.rescheduled:' || p_appointment_id::text || ':' || extract(epoch from p_window_start)::bigint,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'reschedule outbox emit failed: %', SQLERRM; END;
END $$;

GRANT EXECUTE ON FUNCTION public.reschedule_dock_appointment(uuid,uuid,timestamptz,timestamptz) TO authenticated;

-- ---------------------------------------------------------------------
-- Phase C — yard zones
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_yard_slots
  ADD COLUMN IF NOT EXISTS zone_kind text NOT NULL DEFAULT 'parking_bay',
  ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE public.wms_yard_slots
    ADD CONSTRAINT wms_yard_slots_zone_kind_chk
    CHECK (zone_kind IN ('waiting_lane','parking_bay','staging','overflow','approach_lane'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_wms_yard_slots_zone
  ON public.wms_yard_slots(warehouse_id, zone_kind, status, sequence);

-- Zone-aware check-in: prefer a slot matching the visit direction, then
-- parking bays, then overflow. Still SKIP LOCKED for concurrent gates.
CREATE OR REPLACE FUNCTION public.check_in_trailer(
  p_warehouse_id uuid,
  p_trailer_ref text,
  p_carrier_id uuid DEFAULT NULL,
  p_driver_name text DEFAULT NULL,
  p_driver_phone text DEFAULT NULL,
  p_seal_in text DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL
) RETURNS wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_wh public.warehouses;
  v_slot uuid;
  v_visit public.wms_trailer_visits;
  v_status text;
  v_direction text;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  IF v_wh.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF p_trailer_ref IS NULL OR btrim(p_trailer_ref) = '' THEN
    RAISE EXCEPTION 'trailer_ref required';
  END IF;

  SELECT appointment_type INTO v_direction
    FROM public.wms_dock_appointments WHERE id = p_appointment_id;

  SELECT id INTO v_slot
    FROM public.wms_yard_slots
   WHERE warehouse_id = p_warehouse_id
     AND status = 'available'
     AND (v_direction IS NULL OR slot_type IN ('either', v_direction))
   ORDER BY CASE zone_kind
              WHEN 'parking_bay'  THEN 1
              WHEN 'waiting_lane' THEN 2
              WHEN 'staging'      THEN 3
              WHEN 'overflow'     THEN 4
              ELSE 5 END,
            sequence ASC, code ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  v_status := CASE WHEN v_slot IS NULL THEN 'arrived' ELSE 'in_yard' END;

  INSERT INTO public.wms_trailer_visits (
    organization_id, business_id, branch_id, warehouse_id,
    carrier_id, trailer_ref, driver_name, driver_phone, seal_in,
    yard_slot_id, appointment_id, status, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    p_carrier_id, btrim(p_trailer_ref), p_driver_name, p_driver_phone, p_seal_in,
    v_slot, p_appointment_id, v_status, auth.uid()
  ) RETURNING * INTO v_visit;

  IF v_slot IS NOT NULL THEN
    UPDATE public.wms_yard_slots SET status = 'occupied' WHERE id = v_slot;
  END IF;

  IF p_appointment_id IS NOT NULL THEN
    UPDATE public.wms_dock_appointments
       SET state = CASE WHEN state = 'scheduled' THEN 'arrived' ELSE state END,
           arrived_at = COALESCE(arrived_at, now())
     WHERE id = p_appointment_id
       AND business_id = v_wh.business_id;
  END IF;

  PERFORM public.emit_yard_event('warehouse.yard.checked_in', v_visit);

  RETURN v_visit;
END $$;

GRANT EXECUTE ON FUNCTION public.check_in_trailer(uuid,text,uuid,text,text,text,uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- Phase D — gate operations
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_gate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  visit_id uuid REFERENCES public.wms_trailer_visits(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES public.wms_dock_appointments(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'checked_in','identity_verified','seal_verified','approved','rejected','exited')),
  actor_user_id uuid,
  identity_kind text CHECK (identity_kind IN ('driver_licence','national_id','badge','passport','other')),
  identity_ref text,
  seal_ref text,
  approved boolean,
  notes text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wms_gate_events_visit ON public.wms_gate_events(visit_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_wms_gate_events_wh ON public.wms_gate_events(warehouse_id, occurred_at DESC);

GRANT SELECT ON public.wms_gate_events TO authenticated;
GRANT ALL ON public.wms_gate_events TO service_role;

ALTER TABLE public.wms_gate_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "wms_gate_events_biz_read" ON public.wms_gate_events
    FOR SELECT TO authenticated
    USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public._wms_log_gate_event(
  p_visit public.wms_trailer_visits,
  p_event_type text,
  p_identity_kind text DEFAULT NULL,
  p_identity_ref text DEFAULT NULL,
  p_seal_ref text DEFAULT NULL,
  p_approved boolean DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.wms_gate_events (
    organization_id, business_id, warehouse_id, visit_id, appointment_id,
    event_type, actor_user_id, identity_kind, identity_ref, seal_ref, approved, notes
  ) VALUES (
    p_visit.organization_id, p_visit.business_id, p_visit.warehouse_id, p_visit.id,
    p_visit.appointment_id, p_event_type, auth.uid(),
    p_identity_kind, p_identity_ref, p_seal_ref, p_approved, p_notes
  ) RETURNING id INTO v_id;

  BEGIN
    PERFORM public._wms_emit_outbox(
      'warehouse.gate.' || p_event_type,
      'trailer_visit', p_visit.id,
      jsonb_build_object(
        'gate_event_id', v_id, 'trailer_visit_id', p_visit.id,
        'appointment_id', p_visit.appointment_id, 'warehouse_id', p_visit.warehouse_id,
        'business_id', p_visit.business_id, 'event_type', p_event_type,
        'identity_kind', p_identity_kind, 'seal_ref', p_seal_ref, 'approved', p_approved),
      p_visit.organization_id, p_visit.branch_id, p_visit.warehouse_id,
      'wms.gate_event:' || v_id::text, NULL);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'gate event emission failed: %', SQLERRM; END;

  RETURN v_id;
END $$;

-- Gate check-in: resolve appointment by QR token when provided, then
-- delegate the physical arrival to check_in_trailer.
CREATE OR REPLACE FUNCTION public.gate_check_in(
  p_warehouse_id uuid,
  p_trailer_ref text,
  p_qr_token text DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_carrier_id uuid DEFAULT NULL,
  p_driver_name text DEFAULT NULL,
  p_driver_phone text DEFAULT NULL,
  p_seal_in text DEFAULT NULL,
  p_identity_kind text DEFAULT NULL,
  p_identity_ref text DEFAULT NULL
) RETURNS wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_appt public.wms_dock_appointments;
  v_appt_id uuid := p_appointment_id;
  v_visit public.wms_trailer_visits;
BEGIN
  IF p_qr_token IS NOT NULL AND btrim(p_qr_token) <> '' THEN
    SELECT * INTO v_appt FROM public.wms_dock_appointments WHERE qr_token = btrim(p_qr_token);
    IF NOT FOUND THEN RAISE EXCEPTION 'no appointment matches that code'; END IF;
    IF v_appt.warehouse_id <> p_warehouse_id THEN
      RAISE EXCEPTION 'appointment belongs to another warehouse';
    END IF;
    IF v_appt.state IN ('cancelled','completed','no_show') THEN
      RAISE EXCEPTION 'appointment is % and cannot be checked in', v_appt.state;
    END IF;
    v_appt_id := v_appt.id;
  END IF;

  v_visit := public.check_in_trailer(
    p_warehouse_id,
    COALESCE(NULLIF(btrim(COALESCE(p_trailer_ref,'')), ''), v_appt.trailer_ref, 'UNKNOWN'),
    COALESCE(p_carrier_id, v_appt.carrier_id),
    COALESCE(p_driver_name, v_appt.driver_name),
    COALESCE(p_driver_phone, v_appt.driver_phone),
    p_seal_in,
    v_appt_id
  );

  PERFORM public._wms_log_gate_event(v_visit, 'checked_in', p_identity_kind, p_identity_ref, p_seal_in, NULL, NULL);
  IF p_identity_ref IS NOT NULL THEN
    PERFORM public._wms_log_gate_event(v_visit, 'identity_verified', p_identity_kind, p_identity_ref, NULL, true, NULL);
  END IF;
  IF p_seal_in IS NOT NULL THEN
    PERFORM public._wms_log_gate_event(v_visit, 'seal_verified', NULL, NULL, p_seal_in, true, NULL);
  END IF;

  RETURN v_visit;
END $$;

GRANT EXECUTE ON FUNCTION public.gate_check_in(uuid,text,text,uuid,uuid,text,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.gate_approve(
  p_visit_id uuid,
  p_approved boolean DEFAULT true,
  p_notes text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_visit public.wms_trailer_visits;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  PERFORM public._wms_log_gate_event(
    v_visit, CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
    NULL, NULL, NULL, p_approved, p_notes);
END $$;

GRANT EXECUTE ON FUNCTION public.gate_approve(uuid,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.gate_exit(
  p_visit_id uuid,
  p_seal_out text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_visit public.wms_trailer_visits;
BEGIN
  v_visit := public.depart_trailer(p_visit_id, p_seal_out);
  PERFORM public._wms_log_gate_event(v_visit, 'exited', NULL, NULL, p_seal_out, NULL, p_notes);

  IF v_visit.appointment_id IS NOT NULL THEN
    UPDATE public.wms_dock_appointments
       SET departed_at = COALESCE(departed_at, now())
     WHERE id = v_visit.appointment_id;
  END IF;

  RETURN v_visit;
END $$;

GRANT EXECUTE ON FUNCTION public.gate_exit(uuid,text,text) TO authenticated;