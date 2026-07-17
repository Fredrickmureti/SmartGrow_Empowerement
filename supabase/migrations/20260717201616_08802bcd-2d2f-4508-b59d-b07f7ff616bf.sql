
DO $$ BEGIN
  CREATE TYPE public.wms_dock_type AS ENUM ('receiving','shipping','both');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_manifest_state AS ENUM ('draft','loading','closed','dispatched','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. Docks --------------------------------------------------------
CREATE TABLE public.warehouse_docks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  name text NULL,
  dock_type public.wms_dock_type NOT NULL DEFAULT 'shipping',
  is_active boolean NOT NULL DEFAULT true,
  notes text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code)
);
CREATE INDEX idx_warehouse_docks_wh ON public.warehouse_docks(warehouse_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.warehouse_docks TO authenticated;
GRANT ALL ON public.warehouse_docks TO service_role;

ALTER TABLE public.warehouse_docks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_docks business scoped select"
  ON public.warehouse_docks FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY "warehouse_docks business scoped write"
  ON public.warehouse_docks FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_warehouse_docks_updated_at
  BEFORE UPDATE ON public.warehouse_docks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Loading manifests -------------------------------------------
CREATE TABLE public.wms_loading_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NULL,
  warehouse_id uuid NOT NULL,
  dock_id uuid NULL REFERENCES public.warehouse_docks(id),
  carrier_id uuid NULL,
  code text NOT NULL,
  state public.wms_manifest_state NOT NULL DEFAULT 'loading',
  planned_departure_at timestamptz NULL,
  closed_at timestamptz NULL,
  closed_by uuid NULL,
  dispatched_at timestamptz NULL,
  dispatched_by uuid NULL,
  notes text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);
CREATE INDEX idx_wms_manifests_wh_state ON public.wms_loading_manifests(warehouse_id, state);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_loading_manifests TO authenticated;
GRANT ALL ON public.wms_loading_manifests TO service_role;

ALTER TABLE public.wms_loading_manifests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_loading_manifests business scoped select"
  ON public.wms_loading_manifests FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY "wms_loading_manifests business scoped write"
  ON public.wms_loading_manifests FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_wms_loading_manifests_updated_at
  BEFORE UPDATE ON public.wms_loading_manifests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Manifest ↔ cartons ------------------------------------------
ALTER TABLE public.wms_pack_cartons
  ADD COLUMN IF NOT EXISTS manifest_id uuid NULL REFERENCES public.wms_loading_manifests(id);

CREATE TABLE public.wms_manifest_cartons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id uuid NOT NULL REFERENCES public.wms_loading_manifests(id) ON DELETE CASCADE,
  carton_id uuid NOT NULL REFERENCES public.wms_pack_cartons(id),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  sequence int NOT NULL DEFAULT 0,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  loaded_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manifest_id, carton_id)
);
CREATE INDEX idx_wms_manifest_cartons_manifest ON public.wms_manifest_cartons(manifest_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_manifest_cartons TO authenticated;
GRANT ALL ON public.wms_manifest_cartons TO service_role;

ALTER TABLE public.wms_manifest_cartons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_manifest_cartons business scoped select"
  ON public.wms_manifest_cartons FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY "wms_manifest_cartons business scoped write"
  ON public.wms_manifest_cartons FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- 4. open_loading_manifest ---------------------------------------
CREATE OR REPLACE FUNCTION public.open_loading_manifest(
  p_dock_id uuid,
  p_carrier_id uuid DEFAULT NULL,
  p_planned_departure_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dock record;
  v_id uuid;
  v_code text;
BEGIN
  SELECT id, organization_id, business_id, warehouse_id INTO v_dock
    FROM public.warehouse_docks WHERE id = p_dock_id;
  IF v_dock.id IS NULL THEN RAISE EXCEPTION 'dock % not found', p_dock_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_dock.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  v_code := 'LM-' || to_char(now(),'YYMMDD-HH24MISS');

  INSERT INTO public.wms_loading_manifests (
    organization_id, business_id, warehouse_id, dock_id, carrier_id,
    code, state, planned_departure_at, created_by
  ) VALUES (
    v_dock.organization_id, v_dock.business_id, v_dock.warehouse_id, p_dock_id, p_carrier_id,
    v_code, 'loading', p_planned_departure_at, auth.uid()
  )
  RETURNING id INTO v_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_dock.organization_id, v_dock.warehouse_id, 'warehouse.manifest.opened',
      'wms_loading_manifest', v_id,
      jsonb_build_object('manifest_id', v_id, 'business_id', v_dock.business_id, 'dock_id', p_dock_id, 'code', v_code),
      'wms.manifest.opened:' || v_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'manifest opened outbox emit failed: %', SQLERRM; END;

  RETURN v_id;
END; $$;

-- 5. load_carton_onto_manifest -----------------------------------
CREATE OR REPLACE FUNCTION public.load_carton_onto_manifest(
  p_manifest_id uuid,
  p_carton_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  RETURN COALESCE(v_link_id, p_carton_id);
END; $$;

-- 6. close_loading_manifest --------------------------------------
CREATE OR REPLACE FUNCTION public.close_loading_manifest(
  p_manifest_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_m record;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_m.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_m.state <> 'loading' THEN RAISE EXCEPTION 'cannot close manifest in state %', v_m.state; END IF;

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

-- 7. dispatch_loading_manifest -----------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_loading_manifest(
  p_manifest_id uuid,
  p_departure_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_m record;
  v_carton record;
  v_shipped_count int := 0;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_m.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_m.state NOT IN ('loading','closed') THEN
    RAISE EXCEPTION 'cannot dispatch manifest in state %', v_m.state;
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
      jsonb_build_object('manifest_id', p_manifest_id, 'business_id', v_m.business_id, 'carton_count', v_shipped_count),
      'wms.manifest.dispatched:' || p_manifest_id::text, 'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'manifest dispatched outbox emit failed: %', SQLERRM; END;

  RETURN jsonb_build_object('manifest_id', p_manifest_id, 'shipped_cartons', v_shipped_count);
END; $$;
