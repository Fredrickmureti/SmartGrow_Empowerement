
-- ============================================================
-- Phase 2.4 §1 — Optimistic concurrency & load event
-- ============================================================

-- 1. Add row_version to the five remaining WMS aggregates.
ALTER TABLE public.wms_pick_waves        ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.wms_pack_cartons      ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.wms_loading_manifests ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.wms_qc_inspections    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.wms_count_sessions    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

-- 2. Shared auto-bump trigger. Bumps only when caller left row_version
-- unchanged (preserves explicit set-and-check use in transition RPCs).
CREATE OR REPLACE FUNCTION public._wms_auto_bump_row_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.row_version IS NULL OR NEW.row_version = OLD.row_version THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wms_pick_waves','wms_pack_cartons','wms_loading_manifests',
    'wms_qc_inspections','wms_count_sessions'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_row_version ON public.%1$s;
       CREATE TRIGGER trg_%1$s_row_version
         BEFORE UPDATE ON public.%1$s
         FOR EACH ROW EXECUTE FUNCTION public._wms_auto_bump_row_version();',
      t
    );
  END LOOP;
END $$;

-- 3. Fix N7 gap: `load_carton_onto_manifest` did not emit an outbox
-- event, so realtime boards missed carton-onto-manifest transitions.
CREATE OR REPLACE FUNCTION public.load_carton_onto_manifest(p_manifest_id uuid, p_carton_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_m record;
  v_c record;
  v_seq int;
  v_link_id uuid;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_m.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_m.state <> 'loading' THEN RAISE EXCEPTION 'manifest state % refuses load', v_m.state; END IF;

  SELECT * INTO v_c FROM public.wms_pack_cartons WHERE id = p_carton_id;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'carton % not found', p_carton_id; END IF;
  IF v_c.sealed_at IS NULL THEN RAISE EXCEPTION 'carton % is not sealed', p_carton_id; END IF;
  IF v_c.manifest_id IS NOT NULL AND v_c.manifest_id <> p_manifest_id THEN
    RAISE EXCEPTION 'carton % already on another manifest', p_carton_id;
  END IF;

  SELECT COALESCE(MAX(sequence),0)+1 INTO v_seq
    FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;

  INSERT INTO public.wms_manifest_cartons (
    manifest_id, carton_id, organization_id, business_id, sequence, loaded_by
  ) VALUES (
    p_manifest_id, p_carton_id, v_m.organization_id, v_m.business_id, v_seq, auth.uid()
  )
  ON CONFLICT (manifest_id, carton_id) DO NOTHING
  RETURNING id INTO v_link_id;

  UPDATE public.wms_pack_cartons SET manifest_id = p_manifest_id WHERE id = p_carton_id;

  -- Emit onto the outbox so realtime boards can react.
  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_m.organization_id, v_c.branch_id, v_m.warehouse_id,
      'warehouse.carton.loaded',
      'wms_pack_carton', p_carton_id,
      jsonb_build_object(
        'carton_id',   p_carton_id,
        'manifest_id', p_manifest_id,
        'business_id', v_m.business_id,
        'sequence',    v_seq,
        'link_id',     v_link_id
      ),
      'wms.carton.loaded:' || p_carton_id::text || ':' || p_manifest_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms carton loaded outbox emit failed: %', SQLERRM;
  END;

  RETURN COALESCE(v_link_id, p_carton_id);
END; $function$;

-- 4. Register the new topic in the events catalog (SoT for observability).
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, idempotency_key_shape, description)
VALUES (
  'warehouse.carton.loaded',
  'carton',
  'loaded',
  ARRAY['load_carton_onto_manifest'],
  ARRAY['dispatch_board','manifest_view','3pl_billing_meter'],
  'wms.carton.loaded:{carton_id}:{manifest_id}',
  'Sealed carton was added to a loading manifest. Emitted by load_carton_onto_manifest.'
)
ON CONFLICT (topic) DO UPDATE SET
  producers = EXCLUDED.producers,
  consumers = EXCLUDED.consumers,
  idempotency_key_shape = EXCLUDED.idempotency_key_shape,
  description = EXCLUDED.description,
  updated_at = now();
