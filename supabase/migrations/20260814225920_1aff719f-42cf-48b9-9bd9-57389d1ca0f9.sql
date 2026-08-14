-- ── Phase 6: handling unit vs product packaging ────────────────────────────
-- 1. Capacity enforcement is configuration, not a hardcoded literal.
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS enforce_handling_unit_capacity boolean NOT NULL DEFAULT true;

-- 2. Shared mandatory optimistic-lock assertion for plate mutators.
CREATE OR REPLACE FUNCTION public._wms_lpn_assert_version(
  _lpn public.wms_license_plates, _expected_version integer)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF _expected_version IS NULL THEN
    RAISE EXCEPTION 'wms_lpn_version_required' USING ERRCODE = '22023';
  END IF;
  IF _lpn.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_lpn_stale' USING ERRCODE = '40001';
  END IF;
END $$;

-- 3. Container capacity guard. Weight comes from the canonical Product
CREATE OR REPLACE FUNCTION public._wms_lpn_require_version(_expected_version integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF _expected_version IS NULL THEN
    RAISE EXCEPTION 'wms_lpn_version_required' USING ERRCODE = '22023';
  END IF;
  RETURN _expected_version;
END $$;

-- 3b. Container capacity guard. Weight comes from the canonical Product
--    physical attributes; the container limit from wms_packaging_types.
CREATE OR REPLACE FUNCTION public._wms_lpn_capacity_check(_lpn_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  l public.wms_license_plates;
  v_max numeric;
  v_tare numeric;
  v_weight numeric;
  v_unpriced integer;
  v_enforce boolean;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id;
  IF NOT FOUND OR l.packaging_type_id IS NULL THEN RETURN; END IF;

  SELECT pt.max_weight_kg, COALESCE(pt.tare_weight_kg, 0)
    INTO v_max, v_tare
    FROM public.wms_packaging_types pt
   WHERE pt.id = l.packaging_type_id;
  IF v_max IS NULL OR v_max <= 0 THEN RETURN; END IF;

  -- Base-unit gross weight per product (packaging-level rows excluded: the
  -- quant is already expressed in base units).
  SELECT COALESCE(sum(q.quantity * pa.gross_weight), 0),
         count(*) FILTER (WHERE pa.gross_weight IS NULL)
    INTO v_weight, v_unpriced
    FROM public.stock_quants q
    LEFT JOIN public.product_physical_attributes pa
           ON pa.product_id = q.product_id AND pa.packaging_id IS NULL
   WHERE q.lpn_id = _lpn_id;

  -- No invented measurements: if any content has no canonical weight, the
  -- plate cannot be assessed.
  IF v_unpriced > 0 THEN RETURN; END IF;
  IF v_weight + v_tare <= v_max THEN RETURN; END IF;

  SELECT COALESCE(w.enforce_handling_unit_capacity, true) INTO v_enforce
    FROM public.warehouses w WHERE w.id = l.warehouse_id;

  IF COALESCE(v_enforce, true) THEN
    RAISE EXCEPTION 'WMS_LPN_OVER_CAPACITY: plate % holds %kg against a %kg container limit',
      l.code, round(v_weight + v_tare, 3), v_max USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.wms_exceptions (
    organization_id, business_id, branch_id, warehouse_id, kind, severity,
    aggregate_type, aggregate_id, lpn_id, reason, details, raised_by,
    source_system, idempotency_key)
  VALUES (l.organization_id, l.business_id, l.branch_id, l.warehouse_id,
    'other', 3, 'wms_license_plate', l.id, l.id,
    'Handling unit over container capacity',
    jsonb_build_object('weight_kg', round(v_weight + v_tare, 3), 'max_weight_kg', v_max),
    auth.uid(), 'wms',
    'wms.lpn:' || l.id::text || ':over_capacity:' || l.row_version::text)
  ON CONFLICT DO NOTHING;
END $$;

-- 4. Packaging-aware, version-mandatory plate capture. Old signatures dropped.
DROP FUNCTION IF EXISTS public.wms_lpn_load(uuid, uuid, numeric, text, text);
CREATE FUNCTION public.wms_lpn_load(
  _lpn_id uuid, _product_id uuid, _quantity numeric, _expected_version integer,
  _packaging_id uuid DEFAULT NULL, _lot_number text DEFAULT NULL, _serial_number text DEFAULT NULL)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  l public.wms_license_plates;
  src public.stock_quants;
  v_loc uuid;
  v_qty numeric;
BEGIN
  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'wms_lpn_bad_quantity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  PERFORM public._wms_lpn_assert_version(l, _expected_version);
  IF l.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023'; END IF;

  -- One canonical conversion path (ADR 0142 / Phase 1).
  v_qty := public.wms_to_base_qty(_product_id, _packaging_id, _quantity);

  v_loc := l.current_location_id;
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'wms_lpn_no_location: place the plate in a bin before loading' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO src FROM public.stock_quants
   WHERE product_id = _product_id AND location_id = v_loc
     AND lpn_id IS NULL
     AND COALESCE(lot_number,'') = COALESCE(_lot_number,'')
   FOR UPDATE;
  IF NOT FOUND OR (src.quantity - src.reserved_quantity) < v_qty THEN
    RAISE EXCEPTION 'wms_lpn_insufficient_loose_stock at this bin' USING ERRCODE = '22023';
  END IF;

  UPDATE public.stock_quants SET quantity = quantity - v_qty, updated_at = now() WHERE id = src.id;

  INSERT INTO public.stock_quants (
    organization_id, business_id, branch_id, product_id, location_id,
    lot_number, package_id, owner_id, quantity, lpn_id)
  VALUES (src.organization_id, src.business_id, src.branch_id, _product_id, v_loc,
          _lot_number, src.package_id, src.owner_id, v_qty, _lpn_id)
  ON CONFLICT (product_id, location_id,
               COALESCE(lot_number, ''),
               COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET quantity = public.stock_quants.quantity + EXCLUDED.quantity, updated_at = now();

  PERFORM public._wms_lpn_capacity_check(_lpn_id);

  PERFORM public._wms_lpn_log(l, 'loaded', v_loc, v_loc, NULL, NULL, NULL, v_qty,
    jsonb_build_object('product_id', _product_id, 'lot_number', _lot_number,
                       'serial_number', _serial_number, 'packaging_id', _packaging_id,
                       'entered_quantity', _quantity));

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = _lpn_id RETURNING * INTO l;
  RETURN l;
END $$;

DROP FUNCTION IF EXISTS public.wms_lpn_unload(uuid, uuid, numeric, text);
CREATE FUNCTION public.wms_lpn_unload(
  _lpn_id uuid, _product_id uuid, _quantity numeric, _expected_version integer,
  _packaging_id uuid DEFAULT NULL, _lot_number text DEFAULT NULL)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  l public.wms_license_plates;
  src public.stock_quants;
  v_qty numeric;
BEGIN
  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'wms_lpn_bad_quantity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  PERFORM public._wms_lpn_assert_version(l, _expected_version);
  IF l.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023'; END IF;

  v_qty := public.wms_to_base_qty(_product_id, _packaging_id, _quantity);

  SELECT * INTO src FROM public.stock_quants
   WHERE lpn_id = _lpn_id AND product_id = _product_id
     AND COALESCE(lot_number,'') = COALESCE(_lot_number,'')
   FOR UPDATE;
  IF NOT FOUND OR src.quantity < v_qty THEN
    RAISE EXCEPTION 'wms_lpn_insufficient_plate_stock' USING ERRCODE = '22023';
  END IF;

  UPDATE public.stock_quants SET quantity = quantity - v_qty, updated_at = now() WHERE id = src.id;
  DELETE FROM public.stock_quants WHERE id = src.id AND quantity = 0 AND reserved_quantity = 0;

  INSERT INTO public.stock_quants (
    organization_id, business_id, branch_id, product_id, location_id,
    lot_number, package_id, owner_id, quantity, lpn_id)
  VALUES (src.organization_id, src.business_id, src.branch_id, _product_id, src.location_id,
          _lot_number, src.package_id, src.owner_id, v_qty, NULL)
  ON CONFLICT (product_id, location_id,
               COALESCE(lot_number, ''),
               COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET quantity = public.stock_quants.quantity + EXCLUDED.quantity, updated_at = now();

  PERFORM public._wms_lpn_log(l, 'unloaded', src.location_id, src.location_id, NULL, NULL, NULL, -v_qty,
    jsonb_build_object('product_id', _product_id, 'lot_number', _lot_number,
                       'packaging_id', _packaging_id, 'entered_quantity', _quantity));

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = _lpn_id RETURNING * INTO l;
  RETURN l;
END $$;

DROP FUNCTION IF EXISTS public.wms_lpn_split(uuid, jsonb, public.wms_lpn_type);
CREATE FUNCTION public.wms_lpn_split(
  _lpn_id uuid, _lines jsonb, _expected_version integer,
  _new_lpn_type public.wms_lpn_type DEFAULT NULL)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  PERFORM public._wms_lpn_assert_version(l, _expected_version);
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
    v_qty := public.wms_to_base_qty(
               (line->>'product_id')::uuid,
               NULLIF(line->>'packaging_id','')::uuid,
               (line->>'quantity')::numeric);
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

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = _lpn_id;
  RETURN child;
END $$;

DROP FUNCTION IF EXISTS public.wms_lpn_merge(uuid[], uuid);
CREATE FUNCTION public.wms_lpn_merge(
  _source_lpn_ids uuid[], _target_lpn_id uuid, _expected_version integer)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  t public.wms_license_plates;
  s public.wms_license_plates;
  q RECORD;
  v_src uuid;
  v_total numeric;
BEGIN
  SELECT * INTO t FROM public.wms_license_plates WHERE id = _target_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(t);
  PERFORM public._wms_lpn_assert_version(t, _expected_version);
  IF t.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'wms_lpn_sealed' USING ERRCODE = '22023'; END IF;

  FOREACH v_src IN ARRAY _source_lpn_ids LOOP
    SELECT * INTO s FROM public.wms_license_plates WHERE id = v_src FOR UPDATE;
    IF NOT FOUND OR s.id = t.id THEN CONTINUE; END IF;
    PERFORM public._wms_lpn_guard(s);
    IF s.warehouse_id <> t.warehouse_id THEN
      RAISE EXCEPTION 'wms_lpn_cross_warehouse_merge_unsupported' USING ERRCODE = '22023';
    END IF;

    v_total := 0;
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
       SET status = 'consumed', parent_lpn_id = NULL, row_version = row_version + 1, updated_at = now()
     WHERE id = s.id;

    PERFORM public._wms_lpn_log(s, 'merged_out', s.current_location_id, t.current_location_id,
      s.status::text, 'consumed', t.id, -v_total, jsonb_build_object('target_code', t.code));
    PERFORM public._wms_lpn_log(t, 'merged_in', s.current_location_id, t.current_location_id,
      NULL, NULL, s.id, v_total, jsonb_build_object('source_code', s.code));
  END LOOP;

  PERFORM public._wms_lpn_capacity_check(t.id);

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = t.id RETURNING * INTO t;
  RETURN t;
END $$;

DROP FUNCTION IF EXISTS public.wms_lpn_nest(uuid, uuid);
CREATE FUNCTION public.wms_lpn_nest(
  _child_lpn_id uuid, _parent_lpn_id uuid, _expected_version integer)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c public.wms_license_plates; p public.wms_license_plates;
BEGIN
  SELECT * INTO c FROM public.wms_license_plates WHERE id = _child_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO p FROM public.wms_license_plates WHERE id = _parent_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(c);
  PERFORM public._wms_lpn_guard(p);
  PERFORM public._wms_lpn_assert_version(c, _expected_version);
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
    PERFORM public.wms_lpn_move(c.id, p.current_location_id, c.row_version, 'Nested under ' || p.code);
    SELECT * INTO c FROM public.wms_license_plates WHERE id = _child_lpn_id;
  END IF;

  PERFORM public._wms_lpn_log(c, 'nested', NULL, c.current_location_id, NULL, NULL, p.id, NULL,
    jsonb_build_object('parent_code', p.code));
  RETURN c;
END $$;

DROP FUNCTION IF EXISTS public.wms_lpn_unnest(uuid);
CREATE FUNCTION public.wms_lpn_unnest(_child_lpn_id uuid, _expected_version integer)
RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c public.wms_license_plates; v_parent uuid;
BEGIN
  SELECT * INTO c FROM public.wms_license_plates WHERE id = _child_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(c);
  PERFORM public._wms_lpn_assert_version(c, _expected_version);
  v_parent := c.parent_lpn_id;
  UPDATE public.wms_license_plates
     SET parent_lpn_id = NULL, row_version = row_version + 1, updated_at = now()
   WHERE id = c.id RETURNING * INTO c;
  PERFORM public._wms_lpn_log(c, 'unnested', c.current_location_id, c.current_location_id,
    NULL, NULL, v_parent, NULL, '{}'::jsonb);
  RETURN c;
END $$;

-- 5. The already-versioned mutators stop accepting a NULL version.
DO $do$
DECLARE r record; v_def text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('wms_lpn_move','wms_lpn_dispatch','wms_lpn_seal','wms_lpn_retire',
                         'wms_lpn_receive_return','wms_lpn_set_packaging')
       AND pg_get_function_arguments(p.oid) LIKE '%_expected_version integer DEFAULT NULL%'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(v_def, '_expected_version integer DEFAULT NULL::integer', '_expected_version integer');
    -- Guard style A: an inline "IS NOT NULL AND" comparison becomes mandatory.
    v_def := replace(v_def, '_expected_version IS NOT NULL AND ', '_expected_version IS NULL OR ');
    -- Guard style B: the version is forwarded to wms_transition_lpn with a
    -- COALESCE fallback to the current row — drop the fallback.
    v_def := replace(v_def, 'COALESCE(_expected_version, l.row_version)',
                             'public._wms_lpn_require_version(_expected_version)');
    IF v_def NOT LIKE '%_expected_version IS NULL OR %'
       AND v_def NOT LIKE '%_wms_lpn_require_version(_expected_version)%' THEN
      RAISE EXCEPTION 'WMS_PHASE6: % has no version check to harden', r.proname;
    END IF;
    -- Removing a default requires a drop/recreate.
    EXECUTE 'DROP FUNCTION ' || r.oid::regprocedure::text;
    EXECUTE v_def;
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || r.proname ||
            '(' || (SELECT pg_get_function_identity_arguments(p.oid)
                      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = r.proname
                     ORDER BY p.oid DESC LIMIT 1) || ') TO authenticated';
  END LOOP;
END $do$;

-- 6. Trusted server callers thread the freshly read version.
DO $do$
DECLARE r record; v_def text; v_new text; v_patched integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'complete_putaway_task'
       AND pg_get_functiondef(p.oid) LIKE '%wms_lpn_move%'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      'v_task.destination_location_id,' || E'\n' || '    NULL,',
      'v_task.destination_location_id,' || E'\n' ||
      '    (SELECT row_version FROM public.wms_license_plates WHERE id = v_task.lpn_id),');
    v_new := replace(v_new, 'v_task.lpn_id, v_dest, NULL,',
      'v_task.lpn_id, v_dest, (SELECT row_version FROM public.wms_license_plates WHERE id = v_task.lpn_id),');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'WMS_PHASE6: complete_putaway_task lpn_move call shape changed';
    END IF;
    EXECUTE v_new;
    v_patched := v_patched + 1;
  END LOOP;
  IF v_patched = 0 THEN
    RAISE EXCEPTION 'WMS_PHASE6: no complete_putaway_task overload calls wms_lpn_move';
  END IF;
END $do$;

GRANT EXECUTE ON FUNCTION public.wms_lpn_load(uuid, uuid, numeric, integer, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_lpn_unload(uuid, uuid, numeric, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_lpn_split(uuid, jsonb, integer, public.wms_lpn_type) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_lpn_merge(uuid[], uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_lpn_nest(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_lpn_unnest(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public._wms_lpn_capacity_check(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public._wms_lpn_assert_version(public.wms_license_plates, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_lpn_require_version(integer) FROM PUBLIC;