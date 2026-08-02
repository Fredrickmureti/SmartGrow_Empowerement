-- ============================================================
-- LPN lifecycle: edge table (FSM as data) + lifecycle RPCs
-- ============================================================

CREATE TABLE IF NOT EXISTS public.wms_lpn_status_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_status public.wms_lpn_status NOT NULL,
  to_status   public.wms_lpn_status NOT NULL,
  verb text NOT NULL,
  description text,
  requires_reason boolean NOT NULL DEFAULT false,
  rpc_name text,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_status, to_status)
);

GRANT SELECT ON public.wms_lpn_status_edges TO authenticated;
GRANT ALL ON public.wms_lpn_status_edges TO service_role;

ALTER TABLE public.wms_lpn_status_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_lpn_status_edges_read" ON public.wms_lpn_status_edges;
CREATE POLICY "wms_lpn_status_edges_read"
  ON public.wms_lpn_status_edges FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS trg_wms_lpn_status_edges_touch ON public.wms_lpn_status_edges;
CREATE TRIGGER trg_wms_lpn_status_edges_touch
  BEFORE UPDATE ON public.wms_lpn_status_edges
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.wms_lpn_status_edges
  (from_status, to_status, verb, description, requires_reason, rpc_name, sort_order)
VALUES
  ('draft','receiving','Start receiving','Plate enters the receiving flow',false,NULL,10),
  ('open','receiving','Start receiving','Plate enters the receiving flow',false,NULL,10),
  ('receiving','putaway','Release to putaway','Inspected and ready to be put away',false,NULL,20),
  ('receiving','quarantined','Quarantine','Hold for inspection or damage',true,NULL,25),
  ('putaway','stored','Confirm stored','Plate is in its storage bin',false,NULL,30),
  ('stored','picked','Pick','Plate picked for an order',false,NULL,40),
  ('stored','quarantined','Quarantine','Hold for inspection or damage',true,NULL,45),
  ('stored','consumed','Consume','Contents fully consumed',true,NULL,46),
  ('stored','voided','Void','Cancel this plate',true,NULL,47),
  ('stored','retired','Retire','Container withdrawn from service',true,'wms_lpn_retire',48),
  ('picked','packed','Pack','Plate packed for shipment',false,NULL,50),
  ('packed','sealed','Seal','Seal the handling unit',false,'wms_lpn_seal',60),
  ('packed','staged','Stage','Move to the staging lane',false,NULL,61),
  ('sealed','staged','Stage','Move to the staging lane',false,NULL,70),
  ('staged','loaded','Load','Loaded onto the vehicle',false,NULL,80),
  ('loaded','shipped','Dispatch','Ship the plate; stock leaves the warehouse',false,'wms_lpn_dispatch',90),
  ('quarantined','stored','Release to stock','Cleared by inspection',true,NULL,100),
  ('quarantined','voided','Void','Rejected by inspection',true,NULL,101),
  ('quarantined','retired','Retire','Container withdrawn from service',true,'wms_lpn_retire',102),
  ('shipped','quarantined','Receive return','Plate returned; contents restored for inspection',true,'wms_lpn_receive_return',110),
  ('shipped','retired','Retire','Container withdrawn from service',true,'wms_lpn_retire',111),
  ('shipped','voided','Void','Cancel the shipped plate',true,NULL,112),
  ('draft','voided','Void','Cancel this plate',true,NULL,120)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- ---------- FSM now reads the edge table -------------------
CREATE OR REPLACE FUNCTION public.wms_transition_lpn(
  _lpn_id uuid,
  _to_status public.wms_lpn_status,
  _expected_version integer,
  _to_location uuid DEFAULT NULL,
  _actor uuid DEFAULT auth.uid(),
  _reason text DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.wms_license_plates;
  e public.wms_lpn_status_edges;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found: %', _lpn_id USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF l.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_lpn_stale' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO e FROM public.wms_lpn_status_edges
   WHERE from_status = l.status AND to_status = _to_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_lpn_bad_edge: % -> %', l.status, _to_status USING ERRCODE = '22023';
  END IF;
  IF e.requires_reason AND COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'wms_lpn_reason_required: % -> %', l.status, _to_status USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_license_plates SET
    status = _to_status,
    current_location_id = COALESCE(_to_location, current_location_id),
    row_version = l.row_version + 1,
    updated_at = now()
  WHERE id = _lpn_id
  RETURNING * INTO l;

  RETURN l;
END $function$;

REVOKE ALL ON FUNCTION public.wms_transition_lpn(uuid, public.wms_lpn_status, integer, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_lpn(uuid, public.wms_lpn_status, integer, uuid, uuid, text) TO authenticated;

-- ---------- Seal --------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_lpn_seal(
  _lpn_id uuid,
  _expected_version integer DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE l public.wms_license_plates; v_from public.wms_lpn_status;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF NOT EXISTS (SELECT 1 FROM public.stock_quants WHERE lpn_id = _lpn_id AND quantity <> 0)
     AND NOT EXISTS (SELECT 1 FROM public.wms_license_plates WHERE parent_lpn_id = _lpn_id) THEN
    RAISE EXCEPTION 'wms_lpn_empty_cannot_seal' USING ERRCODE = '22023';
  END IF;
  v_from := l.status;
  l := public.wms_transition_lpn(_lpn_id, 'sealed'::public.wms_lpn_status,
        COALESCE(_expected_version, l.row_version), NULL, auth.uid(), NULL);
  UPDATE public.wms_license_plates SET sealed_at = now() WHERE id = _lpn_id RETURNING * INTO l;
  PERFORM public._wms_lpn_log(l, 'sealed', NULL, NULL, v_from, l.status, NULL, NULL, '{}'::jsonb);
  RETURN l;
END $function$;

REVOKE ALL ON FUNCTION public.wms_lpn_seal(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_seal(uuid, integer) TO authenticated;

-- ---------- Dispatch ----------------------------------------
CREATE OR REPLACE FUNCTION public.wms_lpn_dispatch(
  _lpn_id uuid,
  _expected_version integer DEFAULT NULL,
  _reference text DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.wms_license_plates;
  q RECORD;
  v_branch uuid;
  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_from public.wms_lpn_status;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  v_branch := public._wms_lpn_branch(l);
  v_from := l.status;

  FOR q IN
    SELECT sq.* FROM public.stock_quants sq
     WHERE sq.lpn_id IN (SELECT id FROM public.wms_lpn_tree(_lpn_id))
       AND sq.quantity <> 0
     FOR UPDATE
  LOOP
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id, product_id,
      movement_type, quantity, source_location_id, destination_location_id,
      lot_number, reference_type, reference_id, notes, created_by, movement_date)
    VALUES (
      l.organization_id, l.business_id, v_branch, l.warehouse_id, q.product_id,
      'transfer_out', -q.quantity, q.location_id, NULL,
      q.lot_number, 'wms_lpn', l.id,
      COALESCE(_reference, 'LPN dispatch ' || l.code), auth.uid(), now());

    v_lines := v_lines || jsonb_build_object(
      'product_id', q.product_id, 'lot_number', q.lot_number,
      'quantity', q.quantity, 'location_id', q.location_id,
      'lpn_id', q.lpn_id, 'package_id', q.package_id, 'owner_id', q.owner_id);
    v_total := v_total + q.quantity;

    DELETE FROM public.stock_quants WHERE id = q.id;
  END LOOP;

  l := public.wms_transition_lpn(_lpn_id, 'shipped'::public.wms_lpn_status,
        COALESCE(_expected_version, l.row_version), NULL, auth.uid(), NULL);

  UPDATE public.wms_license_plates
     SET status = 'shipped', row_version = row_version + 1, updated_at = now()
   WHERE id IN (SELECT id FROM public.wms_lpn_tree(_lpn_id)) AND id <> _lpn_id;

  PERFORM public._wms_lpn_log(l, 'dispatched', l.current_location_id, NULL,
    v_from, l.status, NULL, -v_total,
    jsonb_build_object('reference', _reference, 'lines', v_lines));
  RETURN l;
END $function$;

REVOKE ALL ON FUNCTION public.wms_lpn_dispatch(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_dispatch(uuid, integer, text) TO authenticated;

-- ---------- Receive return -----------------------------------
CREATE OR REPLACE FUNCTION public.wms_lpn_receive_return(
  _lpn_id uuid,
  _to_location_id uuid,
  _reason text,
  _expected_version integer DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.wms_license_plates;
  dest public.stock_locations;
  ev RECORD;
  line jsonb;
  v_branch uuid;
  v_total numeric := 0;
  v_from public.wms_lpn_status;
BEGIN
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'wms_lpn_reason_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);

  SELECT * INTO dest FROM public.stock_locations WHERE id = _to_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_location_not_found' USING ERRCODE = 'P0002'; END IF;
  IF dest.warehouse_id <> l.warehouse_id THEN
    RAISE EXCEPTION 'wms_lpn_cross_warehouse_return_unsupported' USING ERRCODE = '22023';
  END IF;

  v_branch := public._wms_lpn_branch(l);
  v_from := l.status;

  SELECT * INTO ev FROM public.wms_lpn_events
   WHERE lpn_id = _lpn_id AND event_type = 'dispatched'
   ORDER BY created_at DESC LIMIT 1;

  IF ev.id IS NOT NULL THEN
    FOR line IN SELECT * FROM jsonb_array_elements(COALESCE(ev.payload->'lines', '[]'::jsonb))
    LOOP
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id, product_id,
        movement_type, quantity, source_location_id, destination_location_id,
        lot_number, reference_type, reference_id, notes, created_by, movement_date)
      VALUES (
        l.organization_id, l.business_id, v_branch, l.warehouse_id,
        (line->>'product_id')::uuid,
        'transfer_in', (line->>'quantity')::numeric, NULL, _to_location_id,
        line->>'lot_number', 'wms_lpn', l.id,
        'LPN return ' || l.code || ' — ' || _reason, auth.uid(), now());

      INSERT INTO public.stock_quants AS sq (
        organization_id, business_id, branch_id, product_id, location_id,
        lot_number, package_id, owner_id, lpn_id, quantity)
      VALUES (
        l.organization_id, l.business_id, v_branch,
        (line->>'product_id')::uuid, _to_location_id,
        line->>'lot_number',
        NULLIF(line->>'package_id','')::uuid,
        NULLIF(line->>'owner_id','')::uuid,
        COALESCE(NULLIF(line->>'lpn_id','')::uuid, _lpn_id),
        (line->>'quantity')::numeric)
      ON CONFLICT (
        product_id, location_id,
        COALESCE(lot_number, ''),
        COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
      ) DO UPDATE SET quantity = sq.quantity + EXCLUDED.quantity, updated_at = now();

      v_total := v_total + (line->>'quantity')::numeric;
    END LOOP;
  END IF;

  l := public.wms_transition_lpn(_lpn_id, 'quarantined'::public.wms_lpn_status,
        COALESCE(_expected_version, l.row_version), _to_location_id, auth.uid(), _reason);

  UPDATE public.wms_license_plates
     SET status = 'quarantined', current_location_id = _to_location_id,
         row_version = row_version + 1, updated_at = now()
   WHERE id IN (SELECT id FROM public.wms_lpn_tree(_lpn_id)) AND id <> _lpn_id;

  PERFORM public._wms_lpn_log(l, 'returned', NULL, _to_location_id,
    v_from, l.status, NULL, v_total, jsonb_build_object('reason', _reason));
  RETURN l;
END $function$;

REVOKE ALL ON FUNCTION public.wms_lpn_receive_return(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_receive_return(uuid, uuid, text, integer) TO authenticated;

-- ---------- Retire -------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_lpn_retire(
  _lpn_id uuid,
  _reason text,
  _expected_version integer DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE l public.wms_license_plates; v_from public.wms_lpn_status;
BEGIN
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'wms_lpn_reason_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);

  IF EXISTS (SELECT 1 FROM public.stock_quants WHERE lpn_id = _lpn_id AND quantity <> 0) THEN
    RAISE EXCEPTION 'wms_lpn_not_empty: unload the plate before retiring it' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wms_license_plates WHERE parent_lpn_id = _lpn_id) THEN
    RAISE EXCEPTION 'wms_lpn_has_children: unnest child plates before retiring' USING ERRCODE = '22023';
  END IF;

  v_from := l.status;
  l := public.wms_transition_lpn(_lpn_id, 'retired'::public.wms_lpn_status,
        COALESCE(_expected_version, l.row_version), NULL, auth.uid(), _reason);

  PERFORM public._wms_lpn_log(l, 'retired', NULL, NULL, v_from, l.status, NULL, NULL,
    jsonb_build_object('reason', _reason));
  RETURN l;
END $function$;

REVOKE ALL ON FUNCTION public.wms_lpn_retire(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_retire(uuid, text, integer) TO authenticated;