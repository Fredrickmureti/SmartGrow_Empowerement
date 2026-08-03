-- =====================================================================
-- Phase C: Proof of dispatch.
--
-- Departure previously recorded only dispatched_at / dispatched_by.
-- Nothing captured WHO took custody, under WHAT seal, with what evidence.
-- This makes the closed -> dispatched edge evidentiary.
--
-- Enforcement lives in the FSM (wms_transition_manifest), never in the
-- client. wms_capture_dispatch_proof is the ONLY write path and also
-- stamps the trailer visit seal_out so the seal on the truck and the seal
-- on the paperwork cannot diverge.
-- =====================================================================

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS require_dispatch_proof boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_dispatch_proofs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  business_id       uuid NOT NULL,
  branch_id         uuid,
  warehouse_id      uuid,
  manifest_id       uuid NOT NULL UNIQUE REFERENCES public.wms_loading_manifests(id) ON DELETE CASCADE,
  seal_number       text,
  driver_name       text,
  driver_id_ref     text,
  signature_url     text,
  photo_urls        text[] NOT NULL DEFAULT '{}',
  gps_lat           numeric(9,6),
  gps_lng           numeric(9,6),
  notes             text,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  captured_by       uuid,
  is_sample_data    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wms_dispatch_proofs_business
  ON public.wms_dispatch_proofs (business_id, captured_at DESC);

-- ---------------------------------------------------------------------
-- 2. Grants
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_dispatch_proofs TO authenticated;
GRANT ALL ON public.wms_dispatch_proofs TO service_role;

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_dispatch_proofs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 4. Policies (read is business scoped; writes go through the RPC, which
--    is SECURITY DEFINER — no direct-write policy is granted.)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "wms_dispatch_proofs business scoped select" ON public.wms_dispatch_proofs;
CREATE POLICY "wms_dispatch_proofs business scoped select"
  ON public.wms_dispatch_proofs FOR SELECT
  TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

DROP TRIGGER IF EXISTS trg_wms_dispatch_proofs_updated_at ON public.wms_dispatch_proofs;
CREATE TRIGGER trg_wms_dispatch_proofs_updated_at
  BEFORE UPDATE ON public.wms_dispatch_proofs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- 5. Capture RPC — the only write path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_capture_dispatch_proof(
  p_manifest_id   uuid,
  p_seal_number   text DEFAULT NULL,
  p_driver_name   text DEFAULT NULL,
  p_driver_id_ref text DEFAULT NULL,
  p_signature_url text DEFAULT NULL,
  p_photo_urls    text[] DEFAULT '{}',
  p_gps_lat       numeric DEFAULT NULL,
  p_gps_lng       numeric DEFAULT NULL,
  p_notes         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_m  public.wms_loading_manifests%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loading manifest not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_m.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business' USING ERRCODE = '42501';
  END IF;

  IF v_m.state = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot capture dispatch proof on a cancelled manifest' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.wms_dispatch_proofs AS dp (
    organization_id, business_id, branch_id, warehouse_id, manifest_id,
    seal_number, driver_name, driver_id_ref, signature_url, photo_urls,
    gps_lat, gps_lng, notes, captured_at, captured_by
  ) VALUES (
    v_m.organization_id, v_m.business_id, v_m.branch_id, v_m.warehouse_id, p_manifest_id,
    NULLIF(btrim(p_seal_number), ''), NULLIF(btrim(p_driver_name), ''),
    NULLIF(btrim(p_driver_id_ref), ''), NULLIF(btrim(p_signature_url), ''),
    COALESCE(p_photo_urls, '{}'), p_gps_lat, p_gps_lng, NULLIF(btrim(p_notes), ''),
    now(), auth.uid()
  )
  ON CONFLICT (manifest_id) DO UPDATE SET
    seal_number   = COALESCE(NULLIF(btrim(EXCLUDED.seal_number), ''),   dp.seal_number),
    driver_name   = COALESCE(NULLIF(btrim(EXCLUDED.driver_name), ''),   dp.driver_name),
    driver_id_ref = COALESCE(NULLIF(btrim(EXCLUDED.driver_id_ref), ''), dp.driver_id_ref),
    signature_url = COALESCE(NULLIF(btrim(EXCLUDED.signature_url), ''), dp.signature_url),
    photo_urls    = CASE WHEN array_length(EXCLUDED.photo_urls, 1) IS NULL
                         THEN dp.photo_urls ELSE EXCLUDED.photo_urls END,
    gps_lat       = COALESCE(EXCLUDED.gps_lat, dp.gps_lat),
    gps_lng       = COALESCE(EXCLUDED.gps_lng, dp.gps_lng),
    notes         = COALESCE(EXCLUDED.notes, dp.notes),
    captured_at   = now(),
    captured_by   = auth.uid(),
    updated_at    = now()
  RETURNING dp.id INTO v_id;

  -- The seal on the truck and the seal on the paperwork must not diverge.
  IF v_m.trailer_visit_id IS NOT NULL AND NULLIF(btrim(p_seal_number), '') IS NOT NULL THEN
    UPDATE public.wms_trailer_visits
       SET seal_out   = NULLIF(btrim(p_seal_number), ''),
           updated_at = now()
     WHERE id = v_m.trailer_visit_id;
  END IF;

  PERFORM public._wms_emit_outbox(
    'warehouse.manifest.proof_captured',
    'wms.manifest.proof:' || p_manifest_id::text,
    v_m.organization_id, v_m.business_id,
    jsonb_build_object(
      'aggregate_id', p_manifest_id,
      'warehouse_id', v_m.warehouse_id,
      'branch_id',    v_m.branch_id,
      'actor_id',     auth.uid(),
      'occurred_at',  now(),
      'manifest_id',  p_manifest_id,
      'proof_id',     v_id,
      'seal_number',  NULLIF(btrim(p_seal_number), '')
    )
  );

  RETURN jsonb_build_object('proof_id', v_id, 'manifest_id', p_manifest_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.wms_capture_dispatch_proof(uuid,text,text,text,text,text[],numeric,numeric,text) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_capture_dispatch_proof(uuid,text,text,text,text,text[],numeric,numeric,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Helper: is proof complete enough to release the load?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_manifest_proof_status(p_manifest_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'required', COALESCE(w.require_dispatch_proof, false),
    'captured', dp.id IS NOT NULL,
    'satisfied', (NOT COALESCE(w.require_dispatch_proof, false))
                 OR (dp.id IS NOT NULL
                     AND dp.seal_number IS NOT NULL
                     AND dp.driver_name IS NOT NULL
                     AND (dp.signature_url IS NOT NULL
                          OR array_length(dp.photo_urls, 1) > 0)),
    'seal_number',   dp.seal_number,
    'driver_name',   dp.driver_name,
    'signature_url', dp.signature_url,
    'photo_urls',    COALESCE(dp.photo_urls, '{}'),
    'captured_at',   dp.captured_at
  )
  FROM public.wms_loading_manifests m
  LEFT JOIN public.warehouses w ON w.id = m.warehouse_id
  LEFT JOIN public.wms_dispatch_proofs dp ON dp.manifest_id = m.id
  WHERE m.id = p_manifest_id;
$function$;

GRANT EXECUTE ON FUNCTION public.wms_manifest_proof_status(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. FSM enforcement — dispatch is refused without proof when the
--    warehouse requires it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_transition_manifest(p_manifest_id uuid, p_to_state wms_manifest_state, p_row_version integer, p_reason text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row        public.wms_loading_manifests%ROWTYPE;
  v_from       wms_manifest_state;
  v_allowed    boolean := false;
  v_new_rv     integer;
  v_short      jsonb;
  v_wave       record;
  v_task       record;
  v_carton     record;
  v_carton_ct  int := 0;
  v_relieved   int := 0;
  v_departure  timestamptz;
  v_proof      jsonb;
BEGIN
  SELECT * INTO v_row FROM public.wms_loading_manifests WHERE id = p_manifest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loading manifest not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'draft'   AND p_to_state IN ('loading','cancelled')     THEN true
    WHEN v_from = 'loading' AND p_to_state IN ('closed','cancelled')      THEN true
    WHEN v_from = 'closed'  AND p_to_state IN ('dispatched','cancelled')  THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal manifest transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  -- ------------------------------------------------------------------
  -- Full scan-out enforcement at close AND dispatch.
  -- ------------------------------------------------------------------
  IF p_to_state IN ('closed','dispatched') THEN
    WITH pairs_on_manifest AS (
      SELECT DISTINCT c.wave_id, c.sales_order_id
        FROM public.wms_manifest_cartons mc
        JOIN public.wms_pack_cartons c ON c.id = mc.carton_id
       WHERE mc.manifest_id = p_manifest_id
    ),
    expected AS (
      SELECT c.id AS carton_id, c.wave_id, c.sales_order_id, c.manifest_id
        FROM public.wms_pack_cartons c
        JOIN pairs_on_manifest p
          ON p.wave_id = c.wave_id
         AND p.sales_order_id = c.sales_order_id
       WHERE c.sealed_at IS NOT NULL
    ),
    missing AS (
      SELECT e.carton_id, e.wave_id, e.sales_order_id
        FROM expected e
        LEFT JOIN public.wms_manifest_cartons mc
          ON mc.carton_id = e.carton_id
       WHERE mc.manifest_id IS NULL
    )
    SELECT jsonb_agg(jsonb_build_object(
             'carton_id', carton_id,
             'wave_id', wave_id,
             'sales_order_id', sales_order_id
           ))
      INTO v_short
      FROM missing;

    IF v_short IS NOT NULL AND jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION 'WMS_SCAN_SHORTAGE: % sealed carton(s) missing from manifest % — %',
        jsonb_array_length(v_short), p_manifest_id, v_short::text
        USING ERRCODE = '22023';
    END IF;

    SELECT count(*) INTO v_carton_ct
      FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;
    IF v_carton_ct = 0 THEN
      RAISE EXCEPTION 'WMS_SCAN_SHORTAGE: manifest % has no loaded cartons', p_manifest_id
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- PROOF OF DISPATCH (Phase C).
  --
  -- When the warehouse requires it, custody cannot transfer without
  -- evidence: seal number, driver name and a signature or photo.
  -- Enforced here so the mobile screen, the Loading Bay and the offline
  -- replay queue are all held to the same rule.
  -- ------------------------------------------------------------------
  IF p_to_state = 'dispatched' THEN
    v_proof := public.wms_manifest_proof_status(p_manifest_id);
    IF NOT COALESCE((v_proof ->> 'satisfied')::boolean, true) THEN
      RAISE EXCEPTION 'WMS_PROOF_REQUIRED: manifest % cannot depart without dispatch proof (seal, driver and signature or photo) — %',
        p_manifest_id, v_proof::text
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- Persist the state change.
  -- ------------------------------------------------------------------
  v_departure := COALESCE(
    NULLIF(p_payload ->> 'departure_at', '')::timestamptz,
    now()
  );

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_loading_manifests SET
    state          = p_to_state,
    row_version    = v_new_rv,
    closed_at      = COALESCE(closed_at,     CASE WHEN p_to_state IN ('closed','dispatched') THEN now() END),
    closed_by      = COALESCE(closed_by,     CASE WHEN p_to_state IN ('closed','dispatched') THEN auth.uid() END),
    dispatched_at  = COALESCE(dispatched_at, CASE WHEN p_to_state = 'dispatched' THEN v_departure END),
    dispatched_by  = COALESCE(dispatched_by, CASE WHEN p_to_state = 'dispatched' THEN auth.uid() END),
    updated_at     = now()
  WHERE id = p_manifest_id;

  -- ------------------------------------------------------------------
  -- LEDGER RELIEF (Phase A).
  -- ------------------------------------------------------------------
  IF p_to_state = 'dispatched' THEN
    FOR v_carton IN
      SELECT c.id            AS carton_id,
             c.shipment_lpn_id,
             lp.status       AS lpn_status,
             lp.row_version  AS lpn_row_version
        FROM public.wms_manifest_cartons mc
        JOIN public.wms_pack_cartons c ON c.id = mc.carton_id
        LEFT JOIN public.wms_license_plates lp ON lp.id = c.shipment_lpn_id
       WHERE mc.manifest_id = p_manifest_id
       ORDER BY c.id
    LOOP
      IF v_carton.shipment_lpn_id IS NOT NULL
         AND v_carton.lpn_status IS DISTINCT FROM 'shipped'::public.wms_lpn_status THEN
        PERFORM public.wms_lpn_dispatch(
          v_carton.shipment_lpn_id,
          v_carton.lpn_row_version,
          'Manifest dispatch ' || COALESCE(v_row.code, p_manifest_id::text)
        );
        v_relieved := v_relieved + 1;
      END IF;

      PERFORM public._wms_emit_outbox(
        'warehouse.carton.shipped',
        'wms.carton.shipped:' || v_carton.carton_id::text,
        v_row.organization_id, v_row.business_id,
        jsonb_build_object(
          'aggregate_id',  v_carton.carton_id,
          'warehouse_id',  v_row.warehouse_id,
          'branch_id',     v_row.branch_id,
          'actor_id',      auth.uid(),
          'occurred_at',   now(),
          'carton_id',     v_carton.carton_id,
          'manifest_id',   p_manifest_id,
          'lpn_id',        v_carton.shipment_lpn_id
        )
      );
    END LOOP;
  END IF;

  IF p_to_state = 'dispatched' THEN
    PERFORM public._wms_manifest_after_dispatch(p_manifest_id);
  END IF;

  PERFORM public._wms_emit_outbox(
    'warehouse.manifest.' || p_to_state::text,
    'wms.manifest:' || p_manifest_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_manifest_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb),
      'lpns_relieved', v_relieved
    )
  );

  -- ------------------------------------------------------------------
  -- Cancellation cascade.
  -- ------------------------------------------------------------------
  IF p_to_state = 'cancelled' THEN
    FOR v_wave IN
      SELECT DISTINCT c.wave_id
        FROM public.wms_manifest_cartons mc
        JOIN public.wms_pack_cartons c ON c.id = mc.carton_id
       WHERE mc.manifest_id = p_manifest_id
         AND c.wave_id IS NOT NULL
    LOOP
      PERFORM public._wms_emit_outbox(
        'warehouse.wave.reopened',
        'wms.wave:' || v_wave.wave_id::text || ':reopened_by_manifest:' || p_manifest_id::text,
        v_row.organization_id, v_row.business_id,
        jsonb_build_object(
          'aggregate_id', v_wave.wave_id,
          'warehouse_id', v_row.warehouse_id,
          'branch_id',    v_row.branch_id,
          'actor_id',     auth.uid(),
          'occurred_at',  now(),
          'reason',       COALESCE(p_reason, 'manifest_cancelled'),
          'manifest_id',  p_manifest_id
        )
      );
    END LOOP;

    FOR v_task IN
      SELECT t.id, t.row_version
        FROM public.wms_tasks t
        JOIN public.wms_manifest_cartons mc
          ON mc.carton_id::text = t.source_doc_id::text
       WHERE mc.manifest_id = p_manifest_id
         AND t.task_type = 'load'
         AND t.state NOT IN ('completed','cancelled','done')
    LOOP
      BEGIN
        PERFORM public.wms_transition_task(
          v_task.id, 'cancelled'::wms_task_state, v_task.row_version,
          'manifest_cancelled', jsonb_build_object('manifest_id', p_manifest_id)
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'wms_transition_manifest: could not cancel load task %: %', v_task.id, SQLERRM;
      END;
    END LOOP;

    UPDATE public.wms_pack_cartons
       SET manifest_id = NULL
     WHERE manifest_id = p_manifest_id;

    DELETE FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;
  END IF;

  RETURN jsonb_build_object(
    'row_version', v_new_rv,
    'state', p_to_state,
    'lpns_relieved', v_relieved
  );
END;
$function$;