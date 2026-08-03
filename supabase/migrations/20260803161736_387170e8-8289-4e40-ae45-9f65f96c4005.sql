-- =====================================================================
-- Yard Control Tower: trailer master, yard movement ledger, and the
-- relocate / release / departure-approval RPCs. See ADR 0086.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Trailer master
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_trailers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  code text NOT NULL,
  trailer_type text NOT NULL DEFAULT 'dry_van',
  ownership text NOT NULL DEFAULT 'carrier',
  carrier_id uuid REFERENCES public.carriers(id) ON DELETE SET NULL,
  length_ft numeric,
  capacity_weight numeric,
  capacity_volume numeric,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_trailers_code_uniq UNIQUE (business_id, code),
  CONSTRAINT wms_trailers_type_chk CHECK (trailer_type IN ('dry_van','reefer','flatbed','tanker','container','curtain_side','other')),
  CONSTRAINT wms_trailers_ownership_chk CHECK (ownership IN ('own','carrier','customer','vendor','unknown'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_trailers TO authenticated;
GRANT ALL ON public.wms_trailers TO service_role;

ALTER TABLE public.wms_trailers ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_trailers_biz_read ON public.wms_trailers
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY wms_trailers_biz_write ON public.wms_trailers
  FOR ALL TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS wms_trailers_business_idx ON public.wms_trailers (business_id, is_active);
CREATE INDEX IF NOT EXISTS wms_trailers_carrier_idx ON public.wms_trailers (carrier_id);

CREATE TRIGGER wms_trailers_touch
  BEFORE UPDATE ON public.wms_trailers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Link visits to the master record.
ALTER TABLE public.wms_trailer_visits
  ADD COLUMN IF NOT EXISTS trailer_id uuid REFERENCES public.wms_trailers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS departure_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS departure_approved_by uuid,
  ADD COLUMN IF NOT EXISTS departure_override_reason text;

CREATE INDEX IF NOT EXISTS wms_trailer_visits_trailer_idx ON public.wms_trailer_visits (trailer_id);

-- ---------------------------------------------------------------------
-- 2. Yard movement ledger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_yard_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  visit_id uuid NOT NULL REFERENCES public.wms_trailer_visits(id) ON DELETE CASCADE,
  reason text NOT NULL,
  from_slot_id uuid REFERENCES public.wms_yard_slots(id) ON DELETE SET NULL,
  to_slot_id uuid REFERENCES public.wms_yard_slots(id) ON DELETE SET NULL,
  from_dock_id uuid REFERENCES public.warehouse_docks(id) ON DELETE SET NULL,
  to_dock_id uuid REFERENCES public.warehouse_docks(id) ON DELETE SET NULL,
  from_status text,
  to_status text,
  actor_user_id uuid,
  notes text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_yard_moves_reason_chk CHECK (reason IN ('park','relocate','queue','to_dock','release','depart','no_show'))
);

GRANT SELECT ON public.wms_yard_moves TO authenticated;
GRANT ALL ON public.wms_yard_moves TO service_role;

ALTER TABLE public.wms_yard_moves ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_yard_moves_biz_read ON public.wms_yard_moves
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS wms_yard_moves_visit_idx ON public.wms_yard_moves (visit_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS wms_yard_moves_wh_idx ON public.wms_yard_moves (warehouse_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_log_yard_move(
  p_visit public.wms_trailer_visits,
  p_reason text,
  p_from_slot uuid DEFAULT NULL,
  p_to_slot uuid DEFAULT NULL,
  p_from_dock uuid DEFAULT NULL,
  p_to_dock uuid DEFAULT NULL,
  p_from_status text DEFAULT NULL,
  p_to_status text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.wms_yard_moves (
    organization_id, business_id, warehouse_id, visit_id, reason,
    from_slot_id, to_slot_id, from_dock_id, to_dock_id,
    from_status, to_status, actor_user_id, notes
  ) VALUES (
    p_visit.organization_id, p_visit.business_id, p_visit.warehouse_id, p_visit.id, p_reason,
    p_from_slot, p_to_slot, p_from_dock, p_to_dock,
    p_from_status, p_to_status, auth.uid(), p_notes
  ) RETURNING id INTO v_id;

  BEGIN
    PERFORM public._wms_emit_outbox(
      'warehouse.yard.moved',
      'trailer_visit', p_visit.id,
      jsonb_build_object(
        'yard_move_id', v_id, 'trailer_visit_id', p_visit.id, 'reason', p_reason,
        'from_slot_id', p_from_slot, 'to_slot_id', p_to_slot,
        'from_dock_id', p_from_dock, 'to_dock_id', p_to_dock,
        'from_status', p_from_status, 'to_status', p_to_status,
        'warehouse_id', p_visit.warehouse_id, 'business_id', p_visit.business_id),
      p_visit.organization_id, p_visit.branch_id, p_visit.warehouse_id,
      'wms.yard_move:' || v_id::text, NULL);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'yard move emission failed: %', SQLERRM; END;

  RETURN v_id;
END $$;

-- Resolve (or create) the trailer master row for a free-text reference.
CREATE OR REPLACE FUNCTION public._wms_resolve_trailer(
  p_business_id uuid,
  p_organization_id uuid,
  p_code text,
  p_carrier_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_code text := upper(btrim(COALESCE(p_code,''))); v_id uuid;
BEGIN
  IF v_code = '' THEN RETURN NULL; END IF;

  SELECT id INTO v_id FROM public.wms_trailers
   WHERE business_id = p_business_id AND upper(code) = v_code LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO public.wms_trailers (organization_id, business_id, code, carrier_id, ownership, created_by)
    VALUES (p_organization_id, p_business_id, v_code, p_carrier_id,
            CASE WHEN p_carrier_id IS NULL THEN 'unknown' ELSE 'carrier' END, auth.uid())
    ON CONFLICT (business_id, code) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_id;
  ELSIF p_carrier_id IS NOT NULL THEN
    UPDATE public.wms_trailers SET carrier_id = COALESCE(carrier_id, p_carrier_id), updated_at = now()
     WHERE id = v_id;
  END IF;

  RETURN v_id;
END $$;

-- Open work that must be finished before a trailer may leave.
CREATE OR REPLACE FUNCTION public.trailer_departure_blockers(p_visit_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_visit public.wms_trailer_visits; v_manifests jsonb; v_sessions jsonb;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','loading_manifest','id',m.id,'code',m.code,'state',m.state)), '[]'::jsonb)
    INTO v_manifests
    FROM public.wms_loading_manifests m
   WHERE m.trailer_visit_id = p_visit_id
     AND m.state NOT IN ('dispatched','cancelled');

  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','receiving_session','id',s.id,'code',s.code,'state',s.state)), '[]'::jsonb)
    INTO v_sessions
    FROM public.wms_receiving_sessions s
   WHERE v_visit.appointment_id IS NOT NULL
     AND s.appointment_id = v_visit.appointment_id
     AND s.state NOT IN ('closed','cancelled');

  RETURN v_manifests || v_sessions;
END $$;

GRANT EXECUTE ON FUNCTION public.trailer_departure_blockers(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Transition RPCs
-- ---------------------------------------------------------------------

-- Explicit park / relocate / re-queue.
CREATE OR REPLACE FUNCTION public.relocate_trailer(
  p_visit_id uuid,
  p_slot_id uuid,
  p_notes text DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_slot public.wms_yard_slots;
  v_from_slot uuid;
  v_from_dock uuid;
  v_from_status text;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status IN ('departed','no_show') THEN
    RAISE EXCEPTION 'visit already closed (status=%)', v_visit.status;
  END IF;

  SELECT * INTO v_slot FROM public.wms_yard_slots WHERE id = p_slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'yard slot not found'; END IF;
  IF v_slot.warehouse_id <> v_visit.warehouse_id THEN RAISE EXCEPTION 'slot/warehouse mismatch'; END IF;
  IF v_slot.status = 'blocked' THEN RAISE EXCEPTION 'yard slot % is blocked', v_slot.code; END IF;
  IF v_slot.id <> COALESCE(v_visit.yard_slot_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND EXISTS (SELECT 1 FROM public.wms_trailer_visits
                  WHERE yard_slot_id = p_slot_id AND status NOT IN ('departed','no_show') AND id <> p_visit_id) THEN
    RAISE EXCEPTION 'yard slot % is already occupied', v_slot.code;
  END IF;

  v_from_slot := v_visit.yard_slot_id;
  v_from_dock := v_visit.dock_id;
  v_from_status := v_visit.status;

  UPDATE public.wms_trailer_visits
     SET yard_slot_id = p_slot_id, dock_id = NULL, status = 'in_yard'
   WHERE id = p_visit_id RETURNING * INTO v_visit;

  IF v_from_slot IS NOT NULL AND v_from_slot <> p_slot_id THEN
    UPDATE public.wms_yard_slots SET status = 'available' WHERE id = v_from_slot;
  END IF;
  UPDATE public.wms_yard_slots SET status = 'occupied' WHERE id = p_slot_id;

  PERFORM public._wms_log_yard_move(
    v_visit,
    CASE WHEN v_from_dock IS NOT NULL THEN 'release'
         WHEN v_from_slot IS NULL THEN 'park' ELSE 'relocate' END,
    v_from_slot, p_slot_id, v_from_dock, NULL, v_from_status, v_visit.status, p_notes);

  PERFORM public.emit_yard_event('warehouse.yard.relocated', v_visit);
  RETURN v_visit;
END $$;

GRANT EXECUTE ON FUNCTION public.relocate_trailer(uuid, uuid, text) TO authenticated;

-- Dock -> yard (or unassigned) without departing.
CREATE OR REPLACE FUNCTION public.release_trailer_from_dock(
  p_visit_id uuid,
  p_slot_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_visit public.wms_trailer_visits; v_from_dock uuid; v_from_status text;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status <> 'at_dock' THEN RAISE EXCEPTION 'trailer is not at a dock'; END IF;

  IF p_slot_id IS NOT NULL THEN
    RETURN public.relocate_trailer(p_visit_id, p_slot_id, p_notes);
  END IF;

  v_from_dock := v_visit.dock_id;
  v_from_status := v_visit.status;

  UPDATE public.wms_trailer_visits
     SET dock_id = NULL, status = 'arrived'
   WHERE id = p_visit_id RETURNING * INTO v_visit;

  PERFORM public._wms_log_yard_move(v_visit, 'release', NULL, NULL, v_from_dock, NULL, v_from_status, v_visit.status, p_notes);
  PERFORM public.emit_yard_event('warehouse.yard.released', v_visit);
  RETURN v_visit;
END $$;

GRANT EXECUTE ON FUNCTION public.release_trailer_from_dock(uuid, uuid, text) TO authenticated;

-- Departure approval.
CREATE OR REPLACE FUNCTION public.approve_trailer_departure(
  p_visit_id uuid,
  p_override_reason text DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_visit public.wms_trailer_visits; v_blockers jsonb;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status IN ('departed','no_show') THEN RAISE EXCEPTION 'visit already closed'; END IF;

  v_blockers := public.trailer_departure_blockers(p_visit_id);
  IF jsonb_array_length(v_blockers) > 0 AND COALESCE(btrim(p_override_reason), '') = '' THEN
    RAISE EXCEPTION 'open work prevents departure: %', v_blockers::text;
  END IF;

  UPDATE public.wms_trailer_visits
     SET departure_approved_at = now(),
         departure_approved_by = auth.uid(),
         departure_override_reason = NULLIF(btrim(COALESCE(p_override_reason,'')), '')
   WHERE id = p_visit_id RETURNING * INTO v_visit;

  PERFORM public._wms_log_gate_event(v_visit, 'departure_approved', NULL, NULL, NULL, true,
    NULLIF(btrim(COALESCE(p_override_reason,'')), ''));

  RETURN v_visit;
END $$;

GRANT EXECUTE ON FUNCTION public.approve_trailer_departure(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. Rewire existing transitions: trailer master, yard moves, guard
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_in_trailer(
  p_warehouse_id uuid, p_trailer_ref text, p_carrier_id uuid DEFAULT NULL,
  p_driver_name text DEFAULT NULL, p_driver_phone text DEFAULT NULL,
  p_seal_in text DEFAULT NULL, p_appointment_id uuid DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_wh public.warehouses;
  v_slot uuid;
  v_visit public.wms_trailer_visits;
  v_status text;
  v_direction text;
  v_trailer_id uuid;
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

  v_trailer_id := public._wms_resolve_trailer(v_wh.business_id, v_wh.organization_id, p_trailer_ref, p_carrier_id);

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
    carrier_id, trailer_ref, trailer_id, driver_name, driver_phone, seal_in,
    yard_slot_id, appointment_id, status, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    p_carrier_id, btrim(p_trailer_ref), v_trailer_id, p_driver_name, p_driver_phone, p_seal_in,
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

  PERFORM public._wms_log_yard_move(v_visit,
    CASE WHEN v_slot IS NULL THEN 'queue' ELSE 'park' END,
    NULL, v_slot, NULL, NULL, NULL, v_status, NULL);

  PERFORM public.emit_yard_event('warehouse.yard.checked_in', v_visit);

  RETURN v_visit;
END $$;

CREATE OR REPLACE FUNCTION public.assign_trailer_to_dock(p_visit_id uuid, p_dock_id uuid)
RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_dock public.warehouse_docks;
  v_freed_slot uuid;
  v_from_status text;
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

  IF EXISTS (
    SELECT 1 FROM public.wms_trailer_visits
     WHERE dock_id = p_dock_id AND status = 'at_dock' AND id <> p_visit_id
  ) THEN
    RAISE EXCEPTION 'dock is busy';
  END IF;

  v_freed_slot := v_visit.yard_slot_id;
  v_from_status := v_visit.status;

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

  PERFORM public._wms_log_yard_move(v_visit, 'to_dock', v_freed_slot, NULL, NULL, p_dock_id, v_from_status, 'at_dock', NULL);
  PERFORM public.emit_yard_event('warehouse.yard.docked', v_visit);

  RETURN v_visit;
END $$;

CREATE OR REPLACE FUNCTION public.depart_trailer(p_visit_id uuid, p_seal_out text DEFAULT NULL)
RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_freed_slot uuid;
  v_from_dock uuid;
  v_from_status text;
  v_blockers jsonb;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status = 'departed' THEN
    RAISE EXCEPTION 'visit already departed';
  END IF;

  -- Work-in-progress guard. Cleared either by finishing the work or by an
  -- explicit, recorded override through approve_trailer_departure().
  IF v_visit.departure_approved_at IS NULL THEN
    v_blockers := public.trailer_departure_blockers(p_visit_id);
    IF jsonb_array_length(v_blockers) > 0 THEN
      RAISE EXCEPTION 'open work prevents departure: %', v_blockers::text;
    END IF;
  END IF;

  v_freed_slot := v_visit.yard_slot_id;
  v_from_dock := v_visit.dock_id;
  v_from_status := v_visit.status;

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

  PERFORM public._wms_log_yard_move(v_visit, 'depart', v_freed_slot, NULL, v_from_dock, NULL, v_from_status, 'departed', NULL);
  PERFORM public.emit_yard_event('warehouse.yard.departed', v_visit);

  RETURN v_visit;
END $$;

-- ---------------------------------------------------------------------
-- 6. Realtime
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_trailers REPLICA IDENTITY FULL;
ALTER TABLE public.wms_yard_moves REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_trailers; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_yard_moves; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- Backfill trailer master from existing visits.
INSERT INTO public.wms_trailers (organization_id, business_id, code, carrier_id, ownership)
SELECT DISTINCT ON (v.business_id, upper(btrim(v.trailer_ref)))
       v.organization_id, v.business_id, upper(btrim(v.trailer_ref)), v.carrier_id,
       CASE WHEN v.carrier_id IS NULL THEN 'unknown' ELSE 'carrier' END
  FROM public.wms_trailer_visits v
 WHERE COALESCE(btrim(v.trailer_ref), '') <> ''
 ORDER BY v.business_id, upper(btrim(v.trailer_ref)), v.arrived_at DESC
ON CONFLICT (business_id, code) DO NOTHING;

UPDATE public.wms_trailer_visits v
   SET trailer_id = t.id
  FROM public.wms_trailers t
 WHERE v.trailer_id IS NULL
   AND t.business_id = v.business_id
   AND upper(t.code) = upper(btrim(v.trailer_ref));
