
-- =====================================================================
-- Phase 9 — Yard & Trailer Management (ADR 0080)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) wms_yard_slots — master data (business admins can write via API)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_yard_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  code text NOT NULL,
  slot_type text NOT NULL DEFAULT 'either'
    CHECK (slot_type IN ('inbound','outbound','either','hazmat','reefer')),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','occupied','blocked')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_yard_slots_unique_code UNIQUE (warehouse_id, code)
);

CREATE INDEX IF NOT EXISTS idx_wms_yard_slots_wh_status
  ON public.wms_yard_slots(warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_yard_slots_biz
  ON public.wms_yard_slots(business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_yard_slots TO authenticated;
GRANT ALL ON public.wms_yard_slots TO service_role;

ALTER TABLE public.wms_yard_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_yard_slots_biz_read" ON public.wms_yard_slots
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "wms_yard_slots_biz_write" ON public.wms_yard_slots
  FOR ALL TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE TRIGGER trg_wms_yard_slots_updated_at
  BEFORE UPDATE ON public.wms_yard_slots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- 2) wms_trailer_visits — RPC-only writes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_trailer_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  carrier_id uuid REFERENCES public.carriers(id),
  trailer_ref text NOT NULL,
  driver_name text,
  driver_phone text,
  seal_in text,
  seal_out text,
  yard_slot_id uuid REFERENCES public.wms_yard_slots(id) ON DELETE SET NULL,
  dock_id uuid REFERENCES public.warehouse_docks(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES public.wms_dock_appointments(id) ON DELETE SET NULL,
  arrived_at timestamptz NOT NULL DEFAULT now(),
  docked_at timestamptz,
  departed_at timestamptz,
  dwell_minutes numeric,
  status text NOT NULL DEFAULT 'arrived'
    CHECK (status IN ('arrived','in_yard','at_dock','departed','no_show')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wms_trailer_visits_wh_status
  ON public.wms_trailer_visits(warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_trailer_visits_biz
  ON public.wms_trailer_visits(business_id);
CREATE INDEX IF NOT EXISTS idx_wms_trailer_visits_appt
  ON public.wms_trailer_visits(appointment_id);

GRANT SELECT ON public.wms_trailer_visits TO authenticated;
GRANT ALL ON public.wms_trailer_visits TO service_role;

ALTER TABLE public.wms_trailer_visits ENABLE ROW LEVEL SECURITY;

-- Read only for business members; writes exclusively through SECURITY DEFINER RPCs.
CREATE POLICY "wms_trailer_visits_biz_read" ON public.wms_trailer_visits
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE TRIGGER trg_wms_trailer_visits_updated_at
  BEFORE UPDATE ON public.wms_trailer_visits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- 3) Event emitter helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_yard_event(
  p_type text, p_visit public.wms_trailer_visits
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id, branch_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      p_type, p_visit.organization_id, p_visit.business_id, p_visit.branch_id,
      'trailer_visit', p_visit.id,
      jsonb_build_object(
        'visit_id', p_visit.id,
        'warehouse_id', p_visit.warehouse_id,
        'carrier_id', p_visit.carrier_id,
        'trailer_ref', p_visit.trailer_ref,
        'yard_slot_id', p_visit.yard_slot_id,
        'dock_id', p_visit.dock_id,
        'appointment_id', p_visit.appointment_id,
        'status', p_visit.status,
        'seal_in', p_visit.seal_in,
        'seal_out', p_visit.seal_out,
        'arrived_at', p_visit.arrived_at,
        'docked_at', p_visit.docked_at,
        'departed_at', p_visit.departed_at,
        'dwell_minutes', p_visit.dwell_minutes
      ),
      'wms.trailer_visit:' || p_visit.id || ':' || p_visit.status,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'yard event emission failed: %', SQLERRM;
  END;
END; $$;

-- ---------------------------------------------------------------------
-- 4) RPC: check_in_trailer
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_in_trailer(
  p_warehouse_id uuid,
  p_trailer_ref text,
  p_carrier_id uuid DEFAULT NULL,
  p_driver_name text DEFAULT NULL,
  p_driver_phone text DEFAULT NULL,
  p_seal_in text DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wh public.warehouses;
  v_slot uuid;
  v_visit public.wms_trailer_visits;
  v_status text;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  IF v_wh.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF p_trailer_ref IS NULL OR btrim(p_trailer_ref) = '' THEN
    RAISE EXCEPTION 'trailer_ref required';
  END IF;

  -- Auto-park in first available slot (any type; refinement can filter later).
  SELECT id INTO v_slot
    FROM public.wms_yard_slots
   WHERE warehouse_id = p_warehouse_id
     AND status = 'available'
   ORDER BY code ASC
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
END; $$;

REVOKE ALL ON FUNCTION public.check_in_trailer(uuid,text,uuid,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_in_trailer(uuid,text,uuid,text,text,text,uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 5) RPC: assign_trailer_to_dock
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_trailer_to_dock(
  p_visit_id uuid,
  p_dock_id uuid
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_dock public.warehouse_docks;
  v_freed_slot uuid;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status IN ('departed','no_show') THEN
    RAISE EXCEPTION 'visit already closed (status=%)', v_visit.status;
  END IF;

  SELECT * INTO v_dock FROM public.warehouse_docks WHERE id = p_dock_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dock not found'; END IF;
  IF v_dock.warehouse_id <> v_visit.warehouse_id THEN
    RAISE EXCEPTION 'dock/warehouse mismatch';
  END IF;

  -- Ensure no other active trailer is currently at this dock.
  IF EXISTS (
    SELECT 1 FROM public.wms_trailer_visits
     WHERE dock_id = p_dock_id
       AND status = 'at_dock'
       AND id <> p_visit_id
  ) THEN
    RAISE EXCEPTION 'dock is busy';
  END IF;

  v_freed_slot := v_visit.yard_slot_id;

  UPDATE public.wms_trailer_visits
     SET dock_id = p_dock_id,
         yard_slot_id = NULL,
         docked_at = COALESCE(docked_at, now()),
         status = 'at_dock'
   WHERE id = p_visit_id
   RETURNING * INTO v_visit;

  IF v_freed_slot IS NOT NULL THEN
    UPDATE public.wms_yard_slots SET status = 'available' WHERE id = v_freed_slot;
  END IF;

  IF v_visit.appointment_id IS NOT NULL THEN
    UPDATE public.wms_dock_appointments
       SET state = CASE WHEN state IN ('scheduled','arrived') THEN 'in_progress' ELSE state END
     WHERE id = v_visit.appointment_id
       AND business_id = v_visit.business_id;
  END IF;

  PERFORM public.emit_yard_event('warehouse.yard.docked', v_visit);
  RETURN v_visit;
END; $$;

REVOKE ALL ON FUNCTION public.assign_trailer_to_dock(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_trailer_to_dock(uuid,uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 6) RPC: depart_trailer
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.depart_trailer(
  p_visit_id uuid,
  p_seal_out text DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_freed_slot uuid;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status = 'departed' THEN
    RAISE EXCEPTION 'visit already departed';
  END IF;

  v_freed_slot := v_visit.yard_slot_id;

  UPDATE public.wms_trailer_visits
     SET seal_out = COALESCE(p_seal_out, seal_out),
         departed_at = now(),
         dwell_minutes = EXTRACT(EPOCH FROM (now() - arrived_at)) / 60.0,
         status = 'departed',
         dock_id = NULL,
         yard_slot_id = NULL
   WHERE id = p_visit_id
   RETURNING * INTO v_visit;

  IF v_freed_slot IS NOT NULL THEN
    UPDATE public.wms_yard_slots SET status = 'available' WHERE id = v_freed_slot;
  END IF;

  IF v_visit.appointment_id IS NOT NULL THEN
    UPDATE public.wms_dock_appointments
       SET state = CASE WHEN state IN ('scheduled','arrived','in_progress') THEN 'completed' ELSE state END,
           completed_at = COALESCE(completed_at, now())
     WHERE id = v_visit.appointment_id
       AND business_id = v_visit.business_id;
  END IF;

  PERFORM public.emit_yard_event('warehouse.yard.departed', v_visit);
  RETURN v_visit;
END; $$;

REVOKE ALL ON FUNCTION public.depart_trailer(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.depart_trailer(uuid,text) TO authenticated;
