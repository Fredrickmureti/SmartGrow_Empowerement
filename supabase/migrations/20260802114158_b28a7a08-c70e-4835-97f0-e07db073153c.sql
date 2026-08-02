CREATE OR REPLACE FUNCTION public._maintain_stock_quants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_default_location uuid;
  v_source           uuid;
  v_destination      uuid;
  v_qty              numeric := NEW.quantity;
BEGIN
  IF v_qty = 0 THEN RETURN NEW; END IF;

  -- LPN operations relocate plate-scoped quants themselves; the movement
  -- rows they write are an audit trail, not a balance instruction.
  IF NEW.reference_type = 'wms_lpn' THEN RETURN NEW; END IF;

  v_source      := NEW.source_location_id;
  v_destination := NEW.destination_location_id;

  IF v_source IS NULL AND v_destination IS NULL THEN
    IF NEW.warehouse_id IS NULL THEN RETURN NEW; END IF;
    SELECT id INTO v_default_location
    FROM public.stock_locations
    WHERE warehouse_id = NEW.warehouse_id AND is_default
    LIMIT 1;
    IF v_default_location IS NULL THEN RETURN NEW; END IF;

    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_default_location, NEW.lot_number, v_qty)
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
    RETURN NEW;
  END IF;

  IF v_destination IS NOT NULL THEN
    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_destination, NEW.lot_number, ABS(v_qty))
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  IF v_source IS NOT NULL THEN
    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_source, NEW.lot_number, -ABS(v_qty))
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  RETURN NEW;
END $$;

-- Clean up the loop-variable reuse in the merge RPC (readability + safety).
CREATE OR REPLACE FUNCTION public.wms_lpn_merge(
  _source_lpn_ids uuid[],
  _target_lpn_id uuid
) RETURNS public.wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  UPDATE public.wms_license_plates SET row_version = row_version + 1, updated_at = now()
   WHERE id = t.id RETURNING * INTO t;
  RETURN t;
END $$;