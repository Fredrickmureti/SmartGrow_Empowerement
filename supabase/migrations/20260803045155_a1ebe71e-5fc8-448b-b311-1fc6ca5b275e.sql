-- =====================================================================
-- Phase B: one outbound spine.
--
-- Root cause being fixed: `delivery_notes` (customer-facing: carrier,
-- tracking, proof, notification) and `wms_loading_manifests` (physical:
-- waves, cartons, LPNs, docks, scan-out) shared only the `carriers`
-- picklist. Sales saw a dispatched DN with no cartons; the warehouse saw
-- a dispatched manifest no customer was ever told about.
--
-- Fix: a bidirectional link plus an automatic DN dispatch on manifest
-- departure, routed through the EXISTING dispatch_delivery_atomic RPC so
-- there is no second write path (and the existing SMS/notification
-- triggers still fire).
--
-- Note on inventory: dispatch_delivery_atomic does NOT post stock
-- movements (only complete_delivery_atomic does, at proof-of-delivery).
-- Phase A already relieves stock at departure via wms_lpn_dispatch, so
-- this bridge cannot double-deduct.
-- =====================================================================

ALTER TABLE public.wms_loading_manifests
  ADD COLUMN IF NOT EXISTS delivery_note_id uuid REFERENCES public.delivery_notes(id) ON DELETE SET NULL;

ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS manifest_id uuid REFERENCES public.wms_loading_manifests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_loading_manifests_delivery_note
  ON public.wms_loading_manifests(delivery_note_id) WHERE delivery_note_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_notes_manifest
  ON public.delivery_notes(manifest_id) WHERE manifest_id IS NOT NULL;

COMMENT ON COLUMN public.wms_loading_manifests.delivery_note_id IS
  'Phase B: bound only when the load carries exactly one customer delivery. Consolidated multi-customer loads stay NULL and are linked from delivery_notes.manifest_id instead.';
COMMENT ON COLUMN public.delivery_notes.manifest_id IS
  'Phase B: the physical loading manifest this delivery departed on.';

-- ---------------------------------------------------------------------
-- Resolver: which open delivery notes does this manifest physically carry?
-- Derived from the cartons' sales orders — the only honest join between
-- the two stacks.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_manifest_delivery_notes(p_manifest_id uuid)
RETURNS TABLE(delivery_note_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT dn.id, dn.status
    FROM public.wms_manifest_cartons mc
    JOIN public.wms_pack_cartons c    ON c.id = mc.carton_id
    JOIN public.delivery_notes dn     ON dn.sales_order_id = c.sales_order_id
    JOIN public.wms_loading_manifests m ON m.id = mc.manifest_id
   WHERE mc.manifest_id = p_manifest_id
     AND c.sales_order_id IS NOT NULL
     AND dn.business_id = m.business_id
     AND dn.cancelled_at IS NULL;
$function$;

GRANT EXECUTE ON FUNCTION public.wms_manifest_delivery_notes(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Guard: a carton may not join a manifest already committed to a
-- different customer's delivery.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_manifest_carton_customer_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bound_so uuid;
  v_carton_so uuid;
BEGIN
  SELECT dn.sales_order_id INTO v_bound_so
    FROM public.wms_loading_manifests m
    JOIN public.delivery_notes dn ON dn.id = m.delivery_note_id
   WHERE m.id = NEW.manifest_id;

  IF v_bound_so IS NULL THEN
    RETURN NEW;  -- unbound or consolidated manifest: nothing to enforce
  END IF;

  SELECT c.sales_order_id INTO v_carton_so
    FROM public.wms_pack_cartons c WHERE c.id = NEW.carton_id;

  IF v_carton_so IS DISTINCT FROM v_bound_so THEN
    RAISE EXCEPTION 'WMS_MANIFEST_CUSTOMER_MISMATCH: carton % belongs to a different sales order than the delivery note bound to manifest %',
      NEW.carton_id, NEW.manifest_id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_wms_manifest_carton_customer_guard ON public.wms_manifest_cartons;
CREATE TRIGGER trg_wms_manifest_carton_customer_guard
  BEFORE INSERT OR UPDATE OF manifest_id, carton_id ON public.wms_manifest_cartons
  FOR EACH ROW EXECUTE FUNCTION public._wms_manifest_carton_customer_guard();

-- ---------------------------------------------------------------------
-- Bridge: manifest departure dispatches the customer deliveries it carries.
-- ---------------------------------------------------------------------
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

  SELECT tv.driver_name, tv.vehicle_registration
    INTO v_visit
    FROM public.wms_trailer_visits tv
   WHERE tv.id = v_m.trailer_visit_id;

  FOR v_dn IN SELECT * FROM public.wms_manifest_delivery_notes(p_manifest_id) LOOP
    v_ids := v_ids || v_dn.delivery_note_id;

    UPDATE public.delivery_notes
       SET manifest_id = p_manifest_id, updated_at = now()
     WHERE id = v_dn.delivery_note_id
       AND manifest_id IS DISTINCT FROM p_manifest_id;

    -- Only pending / ready_to_dispatch notes can be dispatched; anything
    -- further along is already accounted for and must be left alone.
    IF v_dn.status IN ('pending', 'ready_to_dispatch') THEN
      v_payload := jsonb_strip_nulls(jsonb_build_object(
        'carrier_id',      v_m.carrier_id,
        'driver_name',     v_visit.driver_name,
        'vehicle_number',  v_visit.vehicle_registration,
        'shipping_method', 'wms_manifest'
      ));
      BEGIN
        PERFORM public.dispatch_delivery_atomic(v_dn.delivery_note_id, auth.uid(), v_payload);
      EXCEPTION WHEN OTHERS THEN
        -- The physical departure is the source of truth and has already
        -- been recorded. A sales-side sync failure must be visible but
        -- must not strand the truck.
        RAISE WARNING 'wms_manifest_bridge_delivery_notes: could not dispatch delivery note %: %',
          v_dn.delivery_note_id, SQLERRM;
      END;
    END IF;
  END LOOP;

  -- Single-customer load: make the link authoritative on the manifest too.
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

GRANT EXECUTE ON FUNCTION public.wms_manifest_bridge_delivery_notes(uuid) TO authenticated, service_role;