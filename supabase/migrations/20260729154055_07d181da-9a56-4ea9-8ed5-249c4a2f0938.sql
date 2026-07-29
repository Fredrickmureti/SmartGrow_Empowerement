-- ============================================================================
-- Phase 3.7 §4 — Legacy manifest RPCs adopt the scan-out invariant, and a
-- preview helper surfaces the gap to the UI.
--
-- The invariant already lives inside `wms_transition_manifest` (migration
-- 20260729153440). The desktop LoadingBay and mobile MobileDispatch still
-- call the legacy `close_loading_manifest` / `dispatch_loading_manifest`
-- RPCs, so both paths must enforce identically — otherwise the operator
-- can bypass the check by using the older codepath.
-- ============================================================================

-- 1. Shared helper: which sealed cartons for this manifest's (wave, SO)
--    pairs are still unshipped (i.e. NOT on this or any closed/dispatched
--    manifest). Returns an array of carton ids.
CREATE OR REPLACE FUNCTION public.wms_manifest_short_cartons(
  p_manifest_id uuid
) RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pairs AS (
    SELECT DISTINCT c.wave_id, c.sales_order_id
      FROM public.wms_pack_cartons c
      JOIN public.wms_manifest_cartons mc ON mc.carton_id = c.id
     WHERE mc.manifest_id = p_manifest_id
  )
  SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[])
    FROM public.wms_pack_cartons c
    JOIN pairs p ON p.wave_id = c.wave_id
                AND (
                  (p.sales_order_id IS NULL AND c.sales_order_id IS NULL)
                  OR p.sales_order_id = c.sales_order_id
                )
   LEFT JOIN public.wms_manifest_cartons mc2 ON mc2.carton_id = c.id
   LEFT JOIN public.wms_loading_manifests m2 ON m2.id = mc2.manifest_id
   WHERE c.sealed_at IS NOT NULL
     AND (mc2.manifest_id IS NULL
          OR (mc2.manifest_id <> p_manifest_id AND m2.state NOT IN ('closed','dispatched')));
$$;

REVOKE ALL ON FUNCTION public.wms_manifest_short_cartons(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_manifest_short_cartons(uuid) TO authenticated, service_role;

-- 2. close_loading_manifest — enforce scan-out.
CREATE OR REPLACE FUNCTION public.close_loading_manifest(
  p_manifest_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m record;
  v_short uuid[];
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id FOR UPDATE;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_m.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_m.state <> 'loading' THEN RAISE EXCEPTION 'cannot close manifest in state %', v_m.state; END IF;

  v_short := public.wms_manifest_short_cartons(p_manifest_id);
  IF array_length(v_short, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'WMS_SCAN_SHORTAGE: % sealed carton(s) not on this manifest', array_length(v_short,1)
      USING ERRCODE = '22023',
            DETAIL  = jsonb_build_object('manifest_id', p_manifest_id, 'missing_carton_ids', v_short)::text;
  END IF;

  UPDATE public.wms_loading_manifests
     SET state='closed', closed_at=now(), closed_by=auth.uid()
   WHERE id=p_manifest_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_m.organization_id, v_m.warehouse_id, 'warehouse.manifest.closed',
      'wms_loading_manifest', p_manifest_id,
      jsonb_build_object('manifest_id', p_manifest_id, 'business_id', v_m.business_id),
      'wms.manifest.closed:' || p_manifest_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'manifest closed outbox emit failed: %', SQLERRM; END;
END; $$;

REVOKE ALL ON FUNCTION public.close_loading_manifest(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_loading_manifest(uuid) TO authenticated, service_role;

-- 3. dispatch_loading_manifest — enforce scan-out.
CREATE OR REPLACE FUNCTION public.dispatch_loading_manifest(
  p_manifest_id uuid,
  p_departure_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m record;
  v_carton record;
  v_shipped_count int := 0;
  v_short uuid[];
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id FOR UPDATE;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_m.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_m.state NOT IN ('loading','closed') THEN
    RAISE EXCEPTION 'cannot dispatch manifest in state %', v_m.state;
  END IF;

  v_short := public.wms_manifest_short_cartons(p_manifest_id);
  IF array_length(v_short, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'WMS_SCAN_SHORTAGE: % sealed carton(s) not on this manifest', array_length(v_short,1)
      USING ERRCODE = '22023',
            DETAIL  = jsonb_build_object('manifest_id', p_manifest_id, 'missing_carton_ids', v_short)::text;
  END IF;

  UPDATE public.wms_loading_manifests
     SET state='dispatched',
         dispatched_at=COALESCE(p_departure_at, now()),
         dispatched_by=auth.uid(),
         closed_at=COALESCE(closed_at, now())
   WHERE id=p_manifest_id;

  FOR v_carton IN
    SELECT c.id, c.shipment_lpn_id
      FROM public.wms_pack_cartons c
      JOIN public.wms_manifest_cartons mc ON mc.carton_id = c.id
     WHERE mc.manifest_id = p_manifest_id
  LOOP
    IF v_carton.shipment_lpn_id IS NOT NULL THEN
      UPDATE public.wms_license_plates
         SET status = 'shipped'
       WHERE id = v_carton.shipment_lpn_id
         AND status <> 'shipped';
    END IF;
    v_shipped_count := v_shipped_count + 1;

    BEGIN
      INSERT INTO public.business_event_outbox (
        org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
        payload, idempotency_key, status, actor_user_id
      ) VALUES (
        v_m.organization_id, v_m.warehouse_id, 'warehouse.carton.shipped',
        'wms_pack_carton', v_carton.id,
        jsonb_build_object('carton_id', v_carton.id, 'manifest_id', p_manifest_id, 'business_id', v_m.business_id),
        'wms.carton.shipped:' || v_carton.id::text, 'pending', auth.uid()
      );
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'carton shipped outbox emit failed: %', SQLERRM; END;
  END LOOP;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_m.organization_id, v_m.warehouse_id, 'warehouse.manifest.dispatched',
      'wms_loading_manifest', p_manifest_id,
      jsonb_build_object('manifest_id', p_manifest_id, 'business_id', v_m.business_id,
                        'shipped_carton_count', v_shipped_count),
      'wms.manifest.dispatched:' || p_manifest_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'manifest dispatched outbox emit failed: %', SQLERRM; END;

  RETURN jsonb_build_object('manifest_id', p_manifest_id, 'shipped_cartons', v_shipped_count);
END; $$;

REVOKE ALL ON FUNCTION public.dispatch_loading_manifest(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_loading_manifest(uuid, timestamptz) TO authenticated, service_role;
