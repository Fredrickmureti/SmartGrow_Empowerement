-- =====================================================================
-- ADR 0105 — Packaging Master, Phase 3 (cartonization v2)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Per-axis fit with free rotation.
--    Sorting both triples descending makes the check rotation-invariant
--    for an axis-aligned placement.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_packaging_fits_item(
  p_item_l numeric, p_item_w numeric, p_item_h numeric,
  p_inner_l numeric, p_inner_w numeric, p_inner_h numeric
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_item_l IS NULL OR p_item_w IS NULL OR p_item_h IS NULL THEN NULL
    WHEN p_inner_l IS NULL OR p_inner_w IS NULL OR p_inner_h IS NULL THEN NULL
    ELSE (
      SELECT bool_and(i.d <= b.d)
        FROM (SELECT d, row_number() OVER (ORDER BY d DESC) rn
                FROM unnest(ARRAY[p_item_l, p_item_w, p_item_h]) d) i
        JOIN (SELECT d, row_number() OVER (ORDER BY d DESC) rn
                FROM unnest(ARRAY[p_inner_l, p_inner_w, p_inner_h]) d) b
          ON b.rn = i.rn
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.wms_packaging_fits_item(numeric, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_fits_item(numeric, numeric, numeric, numeric, numeric, numeric)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2) suggest_packaging — ranked, explainable candidate set
--
--  p_lines   : [{ "product_id": uuid, "quantity": numeric }, ...]
--  p_options : {
--     "carrier_id": uuid, "service_code": text,
--     "warehouse_id": uuid, "require_stocked": bool,
--     "hazmat_class": text, "temp_min_c": num, "temp_max_c": num,
--     "packaging_classes": ["carton","tote"],
--     "include_restricted": bool, "limit": int
--  }
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.suggest_packaging(
  p_business_id uuid,
  p_lines jsonb,
  p_options jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_opt jsonb := COALESCE(p_options, '{}'::jsonb);
  v_carrier uuid := NULLIF(v_opt->>'carrier_id','')::uuid;
  v_service text := NULLIF(v_opt->>'service_code','');
  v_wh uuid := NULLIF(v_opt->>'warehouse_id','')::uuid;
  v_require_stock boolean := COALESCE((v_opt->>'require_stocked')::boolean, false);
  v_hazmat text := NULLIF(trim(COALESCE(v_opt->>'hazmat_class','')),'');
  v_tmin numeric := NULLIF(v_opt->>'temp_min_c','')::numeric;
  v_tmax numeric := NULLIF(v_opt->>'temp_max_c','')::numeric;
  v_classes text[] := CASE WHEN v_opt ? 'packaging_classes'
                           THEN ARRAY(SELECT jsonb_array_elements_text(v_opt->'packaging_classes'))
                           ELSE NULL END;
  v_incl_restricted boolean := COALESCE((v_opt->>'include_restricted')::boolean, false);
  v_limit int := LEAST(GREATEST(COALESCE((v_opt->>'limit')::int, 5), 1), 25);

  v_total_vol numeric := 0;
  v_total_wt  numeric := 0;
  v_missing   jsonb := '[]'::jsonb;
  v_items     jsonb := '[]'::jsonb;
  v_max_dim   numeric := 0;
  v_line      jsonb;
  v_qty       numeric;
  v_p         record;
  v_candidates jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'WMS_PKG_AUTH: authentication required';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'WMS_PKG_FORBIDDEN: business access denied';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines', 'candidates', '[]'::jsonb);
  END IF;

  -- ---- resolve products -------------------------------------------------
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_qty := GREATEST(COALESCE(NULLIF(v_line->>'quantity','')::numeric, 1), 0);
    IF v_qty = 0 THEN CONTINUE; END IF;

    SELECT id, name, sku, length_cm, width_cm, height_cm, weight_kg
      INTO v_p FROM public.products
     WHERE id = NULLIF(v_line->>'product_id','')::uuid;

    IF NOT FOUND THEN
      v_missing := v_missing || jsonb_build_object(
        'product_id', v_line->>'product_id', 'reason', 'product_not_found');
      CONTINUE;
    END IF;

    IF v_p.length_cm IS NULL OR v_p.width_cm IS NULL OR v_p.height_cm IS NULL
       OR v_p.length_cm <= 0 OR v_p.width_cm <= 0 OR v_p.height_cm <= 0 THEN
      v_missing := v_missing || jsonb_build_object(
        'product_id', v_p.id, 'sku', v_p.sku, 'name', v_p.name,
        'reason', 'missing_dimensions');
      CONTINUE;
    END IF;

    v_total_vol := v_total_vol + (v_p.length_cm * v_p.width_cm * v_p.height_cm) * v_qty;
    v_total_wt  := v_total_wt  + COALESCE(v_p.weight_kg, 0) * v_qty;
    v_max_dim   := GREATEST(v_max_dim, v_p.length_cm, v_p.width_cm, v_p.height_cm);

    v_items := v_items || jsonb_build_object(
      'product_id', v_p.id, 'sku', v_p.sku, 'name', v_p.name, 'quantity', v_qty,
      'length_cm', v_p.length_cm, 'width_cm', v_p.width_cm, 'height_cm', v_p.height_cm,
      'weight_kg', COALESCE(v_p.weight_kg, 0));
  END LOOP;

  IF jsonb_array_length(v_missing) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'missing_dimensions',
      'unresolved', v_missing, 'items', v_items, 'candidates', '[]'::jsonb);
  END IF;

  IF v_total_vol <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_measurable_volume', 'candidates', '[]'::jsonb);
  END IF;

  -- ---- score every eligible packaging type ------------------------------
  WITH pkg AS (
    SELECT t.*,
           COALESCE(t.outer_length_cm, t.inner_length_cm) AS o_l,
           COALESCE(t.outer_width_cm,  t.inner_width_cm)  AS o_w,
           COALESCE(t.outer_height_cm, t.inner_height_cm) AS o_h,
           c.is_allowed, c.is_oversize, c.surcharge_amount,
           c.dim_weight_divisor AS carrier_divisor,
           a.is_stocked, a.qty_on_hand
      FROM public.wms_packaging_types t
      LEFT JOIN public.wms_packaging_carriers c
             ON c.packaging_type_id = t.id
            AND v_carrier IS NOT NULL
            AND c.carrier_id = v_carrier
            AND (c.service_code IS NULL OR v_service IS NULL OR c.service_code = v_service)
      LEFT JOIN public.wms_packaging_availability a
             ON a.packaging_type_id = t.id
            AND v_wh IS NOT NULL
            AND a.warehouse_id = v_wh
     WHERE t.business_id = p_business_id
       AND (t.lifecycle_status = 'active'
            OR (v_incl_restricted AND t.lifecycle_status = 'restricted'))
       AND (v_classes IS NULL OR t.packaging_class::text = ANY(v_classes))
  ),
  fitted AS (
    SELECT p.*,
           -- every item must physically fit one empty unit
           (SELECT bool_and(COALESCE(public.wms_packaging_fits_item(
                     (i->>'length_cm')::numeric, (i->>'width_cm')::numeric, (i->>'height_cm')::numeric,
                     p.inner_length_cm, p.inner_width_cm, p.inner_height_cm), false))
              FROM jsonb_array_elements(v_items) i) AS all_items_fit,
           (p.inner_length_cm * p.inner_width_cm * p.inner_height_cm)
             * (COALESCE(p.max_volume_fill_pct, 85) / 100.0) AS usable_cm3
      FROM pkg p
  ),
  sized AS (
    SELECT f.*,
           GREATEST(
             ceil(v_total_vol / NULLIF(f.usable_cm3, 0)),
             CASE WHEN COALESCE(f.max_weight_kg, 0) > 0
                  THEN ceil(v_total_wt / f.max_weight_kg) ELSE 1 END,
             1
           )::int AS units_needed,
           (f.o_l * f.o_w * f.o_h)
             / NULLIF(COALESCE(f.carrier_divisor, f.dim_weight_divisor, 5000), 0) AS dim_weight_kg
      FROM fitted f
     WHERE f.all_items_fit IS TRUE
       AND f.usable_cm3 > 0
       AND (v_carrier IS NULL OR COALESCE(f.is_allowed, false) IS TRUE)
       AND (NOT v_require_stock OR (COALESCE(f.is_stocked, false) IS TRUE))
       AND (v_hazmat IS NULL OR f.hazmat_class = v_hazmat)
       AND (v_tmin IS NULL OR (f.temp_min_c IS NOT NULL AND f.temp_min_c <= v_tmin))
       AND (v_tmax IS NULL OR (f.temp_max_c IS NOT NULL AND f.temp_max_c >= v_tmax))
  ),
  ranked AS (
    SELECT s.*,
           (v_total_wt / s.units_needed) + COALESCE(s.tare_weight_kg, 0) AS actual_per_unit_kg,
           GREATEST((v_total_wt / s.units_needed) + COALESCE(s.tare_weight_kg, 0),
                    s.dim_weight_kg) AS billable_per_unit_kg,
           (s.usable_cm3 * s.units_needed - v_total_vol) AS slack_cm3
      FROM sized s
     WHERE NOT v_require_stock OR s.qty_on_hand IS NULL OR s.qty_on_hand >= s.units_needed
  )
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.rank_no), '[]'::jsonb)
    INTO v_candidates
    FROM (
      SELECT row_number() OVER (
               ORDER BY r.units_needed ASC,
                        r.billable_per_unit_kg ASC,
                        r.slack_cm3 ASC,
                        COALESCE(r.cost, 0) ASC
             ) AS rank_no,
             r.id AS packaging_type_id, r.code, r.name,
             r.packaging_class::text AS packaging_class,
             r.lifecycle_status::text AS lifecycle_status,
             r.units_needed,
             round(r.usable_cm3, 2) AS usable_cm3_per_unit,
             round(v_total_vol, 2) AS content_volume_cm3,
             round(100.0 * v_total_vol / NULLIF(r.usable_cm3 * r.units_needed, 0), 1) AS fill_pct,
             round(r.actual_per_unit_kg, 3) AS actual_weight_kg,
             round(r.dim_weight_kg, 3) AS dim_weight_kg,
             round(r.billable_per_unit_kg, 3) AS billable_weight_kg,
             round(COALESCE(r.cost, 0) * r.units_needed, 2) AS packaging_cost,
             COALESCE(r.surcharge_amount, 0) AS carrier_surcharge,
             COALESCE(r.is_oversize, false) AS carrier_oversize,
             r.is_returnable, r.is_stackable,
             r.qty_on_hand AS stock_on_hand,
             CASE WHEN r.units_needed > 1 THEN 'split_across_units' ELSE 'single_unit' END AS strategy
        FROM ranked r
       ORDER BY 1
       LIMIT v_limit
    ) x;

  IF jsonb_array_length(v_candidates) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM public.wms_packaging_types
           WHERE business_id = p_business_id AND lifecycle_status = 'active'
        ) THEN 'no_active_packaging'
        WHEN NOT EXISTS (
          SELECT 1 FROM public.wms_packaging_types t
           WHERE t.business_id = p_business_id
             AND t.lifecycle_status IN ('active','restricted')
             AND GREATEST(t.inner_length_cm, t.inner_width_cm, t.inner_height_cm) >= v_max_dim
        ) THEN 'item_exceeds_all_packaging'
        ELSE 'no_packaging_matches_constraints'
      END,
      'items', v_items,
      'total_volume_cm3', round(v_total_vol, 2),
      'total_weight_kg', round(v_total_wt, 3),
      'largest_item_dimension_cm', v_max_dim,
      'candidates', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'items', v_items,
    'total_volume_cm3', round(v_total_vol, 2),
    'total_weight_kg', round(v_total_wt, 3),
    'largest_item_dimension_cm', v_max_dim,
    'recommended', v_candidates->0,
    'candidates', v_candidates);
END; $$;

REVOKE ALL ON FUNCTION public.suggest_packaging(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_packaging(uuid, jsonb, jsonb) TO authenticated, service_role;