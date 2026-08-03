-- =====================================================================
-- Phase D — carrier abstraction (ADR-0110)
-- Dispatch must not assume "our own truck". A carrier has a KIND, and a
-- kind decides whether a load needs a tracking number, a label, or
-- nothing at all. Tracking-number allocation is adapter-shaped: today an
-- internal deterministic number, tomorrow a live carrier API, with the
-- same RPC contract.
-- =====================================================================

ALTER TABLE public.carriers
  ADD COLUMN IF NOT EXISTS carrier_kind text NOT NULL DEFAULT 'own_fleet';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'carriers_carrier_kind_check'
  ) THEN
    ALTER TABLE public.carriers
      ADD CONSTRAINT carriers_carrier_kind_check
      CHECK (carrier_kind IN ('parcel','ltl','ftl','courier','own_fleet'));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. Carrier services
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.carrier_services (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  business_id           uuid NOT NULL,
  carrier_id            uuid NOT NULL REFERENCES public.carriers(id) ON DELETE CASCADE,
  code                  text NOT NULL,
  name                  text NOT NULL,
  transit_days          integer,
  tracking_url_template text,
  is_active             boolean NOT NULL DEFAULT true,
  is_sample_data        boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (carrier_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.carrier_services TO authenticated;
GRANT ALL ON public.carrier_services TO service_role;

ALTER TABLE public.carrier_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "carrier_services business scoped select" ON public.carrier_services;
CREATE POLICY "carrier_services business scoped select"
  ON public.carrier_services FOR SELECT TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "carrier_services business scoped write" ON public.carrier_services;
CREATE POLICY "carrier_services business scoped write"
  ON public.carrier_services FOR ALL TO authenticated
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

DROP TRIGGER IF EXISTS trg_carrier_services_updated_at ON public.carrier_services;
CREATE TRIGGER trg_carrier_services_updated_at
  BEFORE UPDATE ON public.carrier_services
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- 2. Manifest carries the shipping contract
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_loading_manifests
  ADD COLUMN IF NOT EXISTS carrier_service_id uuid REFERENCES public.carrier_services(id),
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS tracking_url text;

-- ---------------------------------------------------------------------
-- 3. Allocation RPC — the only write path for tracking identifiers.
--    Idempotent by construction: an already-allocated manifest returns
--    the same number rather than burning a second one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_allocate_tracking_number(
  p_manifest_id uuid,
  p_service_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_m        public.wms_loading_manifests%ROWTYPE;
  v_carrier  public.carriers%ROWTYPE;
  v_svc      public.carrier_services%ROWTYPE;
  v_number   text;
  v_template text;
  v_url      text;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loading manifest not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_m.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business' USING ERRCODE = '42501';
  END IF;

  IF v_m.carrier_id IS NULL THEN
    RAISE EXCEPTION 'WMS_NO_CARRIER: assign a carrier before allocating tracking'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_carrier FROM public.carriers WHERE id = v_m.carrier_id;

  IF p_service_id IS NOT NULL THEN
    SELECT * INTO v_svc FROM public.carrier_services
     WHERE id = p_service_id AND carrier_id = v_m.carrier_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WMS_BAD_SERVICE: service does not belong to this carrier'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_m.carrier_service_id IS NOT NULL THEN
    SELECT * INTO v_svc FROM public.carrier_services WHERE id = v_m.carrier_service_id;
  END IF;

  -- Own fleet moves on the manifest code; there is nothing to track.
  IF COALESCE(v_carrier.carrier_kind, 'own_fleet') = 'own_fleet'
     AND v_m.tracking_number IS NULL THEN
    v_number := v_m.code;
  ELSE
    v_number := COALESCE(
      v_m.tracking_number,
      upper(regexp_replace(COALESCE(v_carrier.name, 'CAR'), '[^A-Za-z0-9]', '', 'g'))
    );
    IF v_m.tracking_number IS NULL THEN
      v_number := substr(v_number, 1, 4) || '-' ||
                  to_char(now(), 'YYMMDD') || '-' ||
                  upper(substr(replace(p_manifest_id::text, '-', ''), 1, 8));
    END IF;
  END IF;

  v_template := COALESCE(v_svc.tracking_url_template, v_carrier.tracking_url_template);
  IF v_template IS NOT NULL THEN
    v_url := replace(v_template, '{tracking_number}', v_number);
    v_url := replace(v_url, '{TRACKING}', v_number);
  END IF;

  UPDATE public.wms_loading_manifests
     SET tracking_number     = v_number,
         tracking_url        = COALESCE(v_url, tracking_url),
         carrier_service_id  = COALESCE(v_svc.id, carrier_service_id),
         updated_at          = now()
   WHERE id = p_manifest_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.manifest.tracking_allocated',
    'wms.manifest.tracking:' || p_manifest_id::text || ':' || v_number,
    v_m.organization_id, v_m.business_id,
    jsonb_build_object(
      'aggregate_id',    p_manifest_id,
      'manifest_id',     p_manifest_id,
      'warehouse_id',    v_m.warehouse_id,
      'branch_id',       v_m.branch_id,
      'actor_id',        auth.uid(),
      'occurred_at',     now(),
      'carrier_id',      v_m.carrier_id,
      'carrier_kind',    COALESCE(v_carrier.carrier_kind, 'own_fleet'),
      'tracking_number', v_number
    )
  );

  RETURN jsonb_build_object(
    'manifest_id',     p_manifest_id,
    'tracking_number', v_number,
    'tracking_url',    v_url,
    'carrier_kind',    COALESCE(v_carrier.carrier_kind, 'own_fleet')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.wms_allocate_tracking_number(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_allocate_tracking_number(uuid, uuid) TO authenticated, service_role;

-- =====================================================================
-- Phase F — the yard boards go live. Both surfaces polled every 15s;
-- publish the tables instead and let the realtime channel invalidate.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'wms_trailer_visits'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_trailer_visits;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'wms_yard_slots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_yard_slots;
  END IF;
END $$;

ALTER TABLE public.wms_trailer_visits REPLICA IDENTITY FULL;
ALTER TABLE public.wms_yard_slots REPLICA IDENTITY FULL;