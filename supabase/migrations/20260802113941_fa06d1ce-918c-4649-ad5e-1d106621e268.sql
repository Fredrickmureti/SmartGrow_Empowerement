-- ============================================================
-- LPN operations (part 2) — move / load / unload / split / merge / nest
-- ============================================================

CREATE OR REPLACE FUNCTION public._wms_lpn_guard(_lpn public.wms_license_plates)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), _lpn.business_id)
     OR (_lpn.branch_id IS NOT NULL AND NOT public.can_access_branch(auth.uid(), _lpn.branch_id))
     OR NOT public.user_has_module_permission(auth.uid(), _lpn.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'wms_lpn_forbidden' USING ERRCODE = '42501';
  END IF;
END $$;

-- Branch fallback for stock_movements (NOT NULL there, nullable on the plate).
CREATE OR REPLACE FUNCTION public._wms_lpn_branch(_lpn public.wms_license_plates)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(_lpn.branch_id, (SELECT w.branch_id FROM public.warehouses w WHERE w.id = _lpn.warehouse_id));
$$;

-- ---------- MOVE ----------
CREATE OR REPLACE FUNCTION public.wms_lpn_move(
  _lpn_id uuid,
  _to_location_id uuid,
  _expected_version integer DEFAULT NULL,
  _reason text DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.wms_license_plates;
  dest public.stock_locations;
  q RECORD;
  v_from uuid;
  v_branch uuid;
  v_moved numeric := 0;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found: %', _lpn_id USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF _expected_version IS NOT NULL AND l.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_lpn_stale' USING ERRCODE = '40001';
  END IF;
  IF l.status::text IN ('shipped','voided','retired','consumed') THEN
    RAISE EXCEPTION 'wms_lpn_immutable: plate is %', l.status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO dest FROM public.stock_locations WHERE id = _to_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_location_not_found' USING ERRCODE = 'P0002'; END IF;
  IF dest.warehouse_id <> l.warehouse_id THEN
    RAISE EXCEPTION 'wms_lpn_cross_warehouse_move_unsupported' USING ERRCODE = '22023';
  END IF;

  v_from := l.current_location_id;
  v_branch := public._wms_lpn_branch(l);

  -- Relocate every quant carried by this plate and its nested children.
  FOR q IN
    SELECT sq.* FROM public.stock_quants sq
    WHERE sq.lpn_id IN (SELECT id FROM public.wms_lpn_tree(_lpn_id))
      AND sq.quantity <> 0
  LOOP
    IF q.location_id <> _to_location_id THEN
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id, product_id,
        movement_type, quantity, source_location_id, destination_location_id,
        lot_number, reference_type, reference_id, notes, created_by, movement_date)
      VALUES
        (l.organization_id, l.business_id, v_branch, l.warehouse_id, q.product_id,
         'transfer_out', -q.quantity, q.location_id, _to_location_id,
         q.lot_number, 'wms_lpn', l.id, COALESCE(_reason, 'LPN move ' || l.code), auth.uid(), now()),
        (l.organization_id, l.business_id, v_branch, l.warehouse_id, q.product_id,
         'transfer_in', q.quantity, q.location_id, _to_location_id,
         q.lot_number, 'wms_lpn', l.id, COALESCE(_reason, 'LPN move ' || l.code), auth.uid(), now());

      UPDATE public.stock_quants SET location_id = _to_location_id, updated_at = now()
      WHERE id = q.id;
      v_moved := v_moved + q.quantity;
    END IF;
  END LOOP;

  UPDATE public.wms_license_plates
     SET current_location_id = _to_location_id,
         row_version = row_version + 1,
         updated_at = now()
   WHERE id = _lpn_id
   RETURNING * INTO l;

  -- Nested children physically travel with the parent.
  UPDATE public.wms_license_plates
     SET current_location_id = _to_location_id, row_version = row_version + 1, updated_at = now()
   WHERE id IN (SELECT id FROM public.wms_lpn_tree(_lpn_id)) AND id <> _lpn_id;

  PERFORM public._wms_lpn_log(l, 'moved', v_from, _to_location_id, NULL, NULL, NULL, v_moved,
    jsonb_build_object('reason', _reason));
  RETURN l;
END $$;

-- ---------- LOAD ----------
CREATE OR REPLACE FUNCTION public.wms_lpn_load(
  _lpn_id uuid,
  _product_id uuid,
  _quantity numeric,
  _lot_number text DEFAULT NULL,
  _serial_number text DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.wms_license_plates;
  src public.stock_quants;
  v_loc uuid;
BEGIN
  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'wms_lpn_bad_quantity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF l.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023';
  END IF;

  v_loc := l.current_location_id;
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'wms_lpn_no_location: place the plate in a bin before loading' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO src FROM public.stock_quants
   WHERE product_id = _product_id AND location_id = v_loc
     AND lpn_id IS NULL
     AND COALESCE(lot_number,'') = COALESCE(_lot_number,'')
   FOR UPDATE;
  IF NOT FOUND OR (src.quantity - src.reserved_quantity) < _quantity THEN
    RAISE EXCEPTION 'wms_lpn_insufficient_loose_stock at this bin' USING ERRCODE = '22023';
  END IF;

  UPDATE public.stock_quants SET quantity = quantity - _quantity, updated_at = now() WHERE id = src.id;

  INSERT INTO public.stock_quants (
    organization_id, business_id, branch_id, product_id, location_id,
    lot_number, package_id, owner_id, quantity, lpn_id)
  VALUES (src.organization_id, src.business_id, src.branch_id, _product_id, v_loc,
          _lot_number, src.package_id, src.owner_id, _quantity, _lpn_id)
  ON CONFLICT (product_id, location_id,
               COALESCE(lot_number, ''),
               COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET quantity = public.stock_quants.quantity + EXCLUDED.quantity, updated_at = now();

  PERFORM public._wms_lpn_log(l, 'loaded', v_loc, v_loc, NULL, NULL, NULL, _quantity,
    jsonb_build_object('product_id', _product_id, 'lot_number', _lot_number, 'serial_number', _serial_number));

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = _lpn_id RETURNING * INTO l;
  RETURN l;
END $$;

-- ---------- UNLOAD ----------
CREATE OR REPLACE FUNCTION public.wms_lpn_unload(
  _lpn_id uuid,
  _product_id uuid,
  _quantity numeric,
  _lot_number text DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.wms_license_plates;
  src public.stock_quants;
BEGIN
  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'wms_lpn_bad_quantity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF l.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023'; END IF;

  SELECT * INTO src FROM public.stock_quants
   WHERE lpn_id = _lpn_id AND product_id = _product_id
     AND COALESCE(lot_number,'') = COALESCE(_lot_number,'')
   FOR UPDATE;
  IF NOT FOUND OR src.quantity < _quantity THEN
    RAISE EXCEPTION 'wms_lpn_insufficient_plate_stock' USING ERRCODE = '22023';
  END IF;

  UPDATE public.stock_quants SET quantity = quantity - _quantity, updated_at = now() WHERE id = src.id;
  DELETE FROM public.stock_quants WHERE id = src.id AND quantity = 0 AND reserved_quantity = 0;

  INSERT INTO public.stock_quants (
    organization_id, business_id, branch_id, product_id, location_id,
    lot_number, package_id, owner_id, quantity, lpn_id)
  VALUES (src.organization_id, src.business_id, src.branch_id, _product_id, src.location_id,
          _lot_number, src.package_id, src.owner_id, _quantity, NULL)
  ON CONFLICT (product_id, location_id,
               COALESCE(lot_number, ''),
               COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET quantity = public.stock_quants.quantity + EXCLUDED.quantity, updated_at = now();

  PERFORM public._wms_lpn_log(l, 'unloaded', src.location_id, src.location_id, NULL, NULL, NULL, -_quantity,
    jsonb_build_object('product_id', _product_id, 'lot_number', _lot_number));

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = _lpn_id RETURNING * INTO l;
  RETURN l;
END $$;

-- ---------- SPLIT ----------
-- _lines: [{"product_id": uuid, "lot_number": text|null, "quantity": numeric}, ...]
CREATE OR REPLACE FUNCTION public.wms_lpn_split(
  _lpn_id uuid,
  _lines jsonb,
  _new_lpn_type public.wms_lpn_type DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.wms_license_plates;
  child public.wms_license_plates;
  line jsonb;
  src public.stock_quants;
  v_qty numeric;
  v_total numeric := 0;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF l.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'wms_lpn_split_no_lines' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.wms_license_plates (
    organization_id, business_id, branch_id, warehouse_id, code, lpn_type,
    status, current_location_id, created_by, notes)
  VALUES (
    l.organization_id, l.business_id, l.branch_id, l.warehouse_id,
    public.wms_next_lpn_code(l.business_id, l.warehouse_id, COALESCE(_new_lpn_type, l.lpn_type)),
    COALESCE(_new_lpn_type, l.lpn_type), l.status, l.current_location_id, auth.uid(),
    'Split from ' || l.code)
  RETURNING * INTO child;

  FOR line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_qty := (line->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'wms_lpn_bad_quantity' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO src FROM public.stock_quants
     WHERE lpn_id = _lpn_id
       AND product_id = (line->>'product_id')::uuid
       AND COALESCE(lot_number,'') = COALESCE(line->>'lot_number','')
     FOR UPDATE;
    IF NOT FOUND OR src.quantity < v_qty THEN
      RAISE EXCEPTION 'wms_lpn_insufficient_plate_stock' USING ERRCODE = '22023';
    END IF;

    UPDATE public.stock_quants SET quantity = quantity - v_qty, updated_at = now() WHERE id = src.id;
    DELETE FROM public.stock_quants WHERE id = src.id AND quantity = 0 AND reserved_quantity = 0;

    INSERT INTO public.stock_quants (
      organization_id, business_id, branch_id, product_id, location_id,
      lot_number, package_id, owner_id, quantity, lpn_id)
    VALUES (src.organization_id, src.business_id, src.branch_id, src.product_id, src.location_id,
            src.lot_number, src.package_id, src.owner_id, v_qty, child.id)
    ON CONFLICT (product_id, location_id,
                 COALESCE(lot_number, ''),
                 COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET quantity = public.stock_quants.quantity + EXCLUDED.quantity, updated_at = now();

    v_total := v_total + v_qty;
  END LOOP;

  PERFORM public._wms_lpn_log(l, 'split_out', l.current_location_id, l.current_location_id,
    NULL, NULL, child.id, -v_total, jsonb_build_object('child_code', child.code, 'lines', _lines));
  PERFORM public._wms_lpn_log(child, 'split_in', l.current_location_id, l.current_location_id,
    NULL, NULL, l.id, v_total, jsonb_build_object('parent_code', l.code, 'lines', _lines));
  RETURN child;
END $$;

-- ---------- MERGE ----------
CREATE OR REPLACE FUNCTION public.wms_lpn_merge(
  _source_lpn_ids uuid[],
  _target_lpn_id uuid
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.wms_license_plates;
  s public.wms_license_plates;
  q RECORD;
  v_total numeric := 0;
BEGIN
  SELECT * INTO t FROM public.wms_license_plates WHERE id = _target_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(t);
  IF t.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023'; END IF;

  FOREACH _target_lpn_id IN ARRAY _source_lpn_ids LOOP
    SELECT * INTO s FROM public.wms_license_plates WHERE id = _target_lpn_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM public._wms_lpn_guard(s);
    IF s.id = t.id THEN CONTINUE; END IF;
    IF s.warehouse_id <> t.warehouse_id THEN
      RAISE EXCEPTION 'wms_lpn_cross_warehouse_merge_unsupported' USING ERRCODE = '22023';
    END IF;

    FOR q IN SELECT * FROM public.stock_quants WHERE lpn_id = s.id FOR UPDATE LOOP
      INSERT INTO public.stock_quants (
        organization_id, business_id, branch_id, product_id, location_id,
        lot_number, package_id, owner_id, quantity, lpn_id)
      VALUES (q.organization_id, q.business_id, q.branch_id, q.product_id,
              COALESCE(t.current_location_id, q.location_id),
              q.lot_number, q.package_id, q.owner_id, q.quantity, t.id)
      ON CONFLICT (product_id, location_id,
                   COALESCE(lot_number, ''),
                   COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
                   COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET quantity = public.stock_quants.quantity + EXCLUDED.quantity, updated_at = now();
      v_total := v_total + q.quantity;
      DELETE FROM public.stock_quants WHERE id = q.id;
    END LOOP;

    UPDATE public.wms_license_plates
       SET status = 'consumed', row_version = row_version + 1, updated_at = now()
     WHERE id = s.id;

    PERFORM public._wms_lpn_log(s, 'merged_out', s.current_location_id, t.current_location_id,
      s.status::text, 'consumed', t.id, NULL, jsonb_build_object('target_code', t.code));
    PERFORM public._wms_lpn_log(t, 'merged_in', s.current_location_id, t.current_location_id,
      NULL, NULL, s.id, v_total, jsonb_build_object('source_code', s.code));
  END LOOP;

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = t.id RETURNING * INTO t;
  RETURN t;
END $$;

-- ---------- NEST / UNNEST ----------
CREATE OR REPLACE FUNCTION public.wms_lpn_nest(
  _child_lpn_id uuid, _parent_lpn_id uuid
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.wms_license_plates; p public.wms_license_plates;
BEGIN
  SELECT * INTO c FROM public.wms_license_plates WHERE id = _child_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO p FROM public.wms_license_plates WHERE id = _parent_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(c);
  PERFORM public._wms_lpn_guard(p);
  IF c.id = p.id OR p.id IN (SELECT id FROM public.wms_lpn_tree(c.id)) THEN
    RAISE EXCEPTION 'wms_lpn_nest_cycle' USING ERRCODE = '22023';
  END IF;
  IF c.warehouse_id <> p.warehouse_id THEN
    RAISE EXCEPTION 'wms_lpn_cross_warehouse_nest_unsupported' USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_license_plates
     SET parent_lpn_id = p.id, row_version = row_version + 1, updated_at = now()
   WHERE id = c.id RETURNING * INTO c;

  IF p.current_location_id IS NOT NULL AND p.current_location_id IS DISTINCT FROM c.current_location_id THEN
    PERFORM public.wms_lpn_move(c.id, p.current_location_id, NULL, 'Nested under ' || p.code);
    SELECT * INTO c FROM public.wms_license_plates WHERE id = _child_lpn_id;
  END IF;

  PERFORM public._wms_lpn_log(c, 'nested', NULL, c.current_location_id, NULL, NULL, p.id, NULL,
    jsonb_build_object('parent_code', p.code));
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION public.wms_lpn_unnest(_child_lpn_id uuid)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.wms_license_plates; v_parent uuid;
BEGIN
  SELECT * INTO c FROM public.wms_license_plates WHERE id = _child_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(c);
  v_parent := c.parent_lpn_id;
  UPDATE public.wms_license_plates
     SET parent_lpn_id = NULL, row_version = row_version + 1, updated_at = now()
   WHERE id = c.id RETURNING * INTO c;
  PERFORM public._wms_lpn_log(c, 'unnested', c.current_location_id, c.current_location_id,
    NULL, NULL, v_parent, NULL, '{}'::jsonb);
  RETURN c;
END $$;

-- ---------- OVERVIEW VIEW ----------
CREATE OR REPLACE VIEW public.v_wms_lpn_overview
WITH (security_invoker = on) AS
SELECT
  l.id, l.organization_id, l.business_id, l.branch_id, l.warehouse_id,
  l.code, l.lpn_type, l.status, l.current_location_id, l.parent_lpn_id,
  l.sealed_at, l.notes, l.row_version, l.created_at, l.updated_at,
  loc.code AS location_code,
  loc.name AS location_name,
  w.name   AS warehouse_name,
  COALESCE(c.sku_count, 0)      AS sku_count,
  COALESCE(c.total_quantity, 0) AS total_quantity,
  COALESCE(ch.child_count, 0)   AS child_count
FROM public.wms_license_plates l
LEFT JOIN public.stock_locations loc ON loc.id = l.current_location_id
LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
LEFT JOIN LATERAL (
  SELECT count(DISTINCT sq.product_id) AS sku_count, sum(sq.quantity) AS total_quantity
  FROM public.stock_quants sq WHERE sq.lpn_id = l.id
) c ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS child_count
  FROM public.wms_license_plates k WHERE k.parent_lpn_id = l.id
) ch ON true;

GRANT SELECT ON public.v_wms_lpn_overview TO authenticated;
GRANT SELECT ON public.v_wms_lpn_overview TO service_role;