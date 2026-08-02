-- ============================================================
-- LPN as a first-class handling unit (part 1)
-- ============================================================

ALTER TABLE public.stock_quants
  ADD COLUMN IF NOT EXISTS lpn_id uuid REFERENCES public.wms_license_plates(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS stock_quants_identity_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS stock_quants_identity_uidx
  ON public.stock_quants (
    product_id, location_id,
    COALESCE(lot_number, ''),
    COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS stock_quants_lpn_idx ON public.stock_quants (lpn_id) WHERE lpn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.wms_lpn_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  business_id      uuid NOT NULL,
  branch_id        uuid,
  warehouse_id     uuid NOT NULL,
  lpn_id           uuid NOT NULL REFERENCES public.wms_license_plates(id) ON DELETE CASCADE,
  event_type       text NOT NULL,
  from_location_id uuid REFERENCES public.stock_locations(id),
  to_location_id   uuid REFERENCES public.stock_locations(id),
  from_status      text,
  to_status        text,
  counterpart_lpn_id uuid REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  quantity_delta   numeric,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id         uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wms_lpn_events_lpn_idx ON public.wms_lpn_events (lpn_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wms_lpn_events_wh_idx  ON public.wms_lpn_events (warehouse_id, created_at DESC);

GRANT SELECT, INSERT ON public.wms_lpn_events TO authenticated;
GRANT ALL ON public.wms_lpn_events TO service_role;
ALTER TABLE public.wms_lpn_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_lpn_events_select ON public.wms_lpn_events;
CREATE POLICY wms_lpn_events_select ON public.wms_lpn_events FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

DROP POLICY IF EXISTS wms_lpn_events_insert ON public.wms_lpn_events;
CREATE POLICY wms_lpn_events_insert ON public.wms_lpn_events FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE TABLE IF NOT EXISTS public.wms_lpn_code_counters (
  business_id  uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  prefix       text NOT NULL,
  next_value   bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, warehouse_id, prefix)
);
GRANT SELECT ON public.wms_lpn_code_counters TO authenticated;
GRANT ALL ON public.wms_lpn_code_counters TO service_role;
ALTER TABLE public.wms_lpn_code_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_lpn_code_counters_select ON public.wms_lpn_code_counters;
CREATE POLICY wms_lpn_code_counters_select ON public.wms_lpn_code_counters FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE OR REPLACE FUNCTION public.wms_next_lpn_code(
  _business_id uuid, _warehouse_id uuid, _lpn_type public.wms_lpn_type DEFAULT 'pallet'
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prefix text := CASE _lpn_type::text
    WHEN 'pallet' THEN 'PLT' WHEN 'carton' THEN 'CTN'
    WHEN 'tote' THEN 'TOT' ELSE 'LPN' END;
  v_next bigint;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'wms_lpn_forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.wms_lpn_code_counters (business_id, warehouse_id, prefix, next_value)
  VALUES (_business_id, _warehouse_id, v_prefix, 2)
  ON CONFLICT (business_id, warehouse_id, prefix)
  DO UPDATE SET next_value = public.wms_lpn_code_counters.next_value + 1
  RETURNING next_value - 1 INTO v_next;
  RETURN v_prefix || '-' || to_char(now(), 'YYMM') || '-' || lpad(v_next::text, 5, '0');
END $$;

CREATE OR REPLACE FUNCTION public.wms_lpn_tree(_lpn_id uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE t AS (
    SELECT l.id FROM public.wms_license_plates l WHERE l.id = _lpn_id
    UNION ALL
    SELECT c.id FROM public.wms_license_plates c JOIN t ON c.parent_lpn_id = t.id
  )
  SELECT id FROM t;
$$;

CREATE OR REPLACE FUNCTION public._wms_lpn_log(
  _lpn public.wms_license_plates, _event_type text,
  _from_loc uuid DEFAULT NULL, _to_loc uuid DEFAULT NULL,
  _from_status text DEFAULT NULL, _to_status text DEFAULT NULL,
  _counterpart uuid DEFAULT NULL, _qty numeric DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.wms_lpn_events (
    organization_id, business_id, branch_id, warehouse_id, lpn_id, event_type,
    from_location_id, to_location_id, from_status, to_status,
    counterpart_lpn_id, quantity_delta, payload, actor_id)
  VALUES (
    _lpn.organization_id, _lpn.business_id, _lpn.branch_id, _lpn.warehouse_id, _lpn.id, _event_type,
    _from_loc, _to_loc, _from_status, _to_status, _counterpart, _qty, _payload, auth.uid());
$$;