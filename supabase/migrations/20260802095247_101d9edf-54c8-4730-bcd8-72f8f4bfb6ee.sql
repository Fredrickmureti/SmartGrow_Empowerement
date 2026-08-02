-- ============================================================================
-- Warehouse layout foundations (ADR 0104)
-- ============================================================================

-- 1. Barcode uniqueness per business ----------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_business_barcode_uniq
  ON public.stock_locations (business_id, upper(btrim(barcode)))
  WHERE barcode IS NOT NULL AND btrim(barcode) <> '';

CREATE INDEX IF NOT EXISTS stock_locations_parent_idx
  ON public.stock_locations (parent_location_id);

-- 2. Legal nesting -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_assert_location_nesting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent_level text;
  v_parent_wh    uuid;
  v_allowed      text[];
BEGIN
  IF NEW.structure_level IS NULL THEN
    RETURN NEW;  -- legacy / auto-seeded default location
  END IF;

  IF NEW.parent_location_id IS NOT NULL THEN
    IF NEW.parent_location_id = NEW.id THEN
      RAISE EXCEPTION 'a location cannot be its own parent';
    END IF;
    SELECT structure_level, warehouse_id INTO v_parent_level, v_parent_wh
      FROM public.stock_locations WHERE id = NEW.parent_location_id;
    IF v_parent_wh IS DISTINCT FROM NEW.warehouse_id THEN
      RAISE EXCEPTION 'parent location belongs to a different warehouse';
    END IF;
  END IF;

  v_allowed := CASE NEW.structure_level
    WHEN 'zone'        THEN ARRAY[]::text[]
    WHEN 'dock'        THEN ARRAY['zone']
    WHEN 'staging_in'  THEN ARRAY['zone']
    WHEN 'staging_out' THEN ARRAY['zone']
    WHEN 'aisle'       THEN ARRAY['zone']
    WHEN 'rack'        THEN ARRAY['aisle']
    WHEN 'shelf'       THEN ARRAY['rack']
    WHEN 'bin'         THEN ARRAY['shelf','rack','aisle','staging_in','staging_out','dock']
    ELSE NULL
  END;

  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'unknown structure level %', NEW.structure_level;
  END IF;

  -- Top-level levels may sit directly under the warehouse (no parent) or under
  -- the auto-seeded default location (structure_level IS NULL).
  IF v_parent_level IS NULL THEN
    IF NEW.structure_level IN ('zone','dock','staging_in','staging_out') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% must sit under a %', NEW.structure_level, array_to_string(v_allowed, ' or ');
  END IF;

  IF NOT (v_parent_level = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'a % cannot sit under a % (allowed: %)',
      NEW.structure_level, v_parent_level, array_to_string(v_allowed, ', ');
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_location_nesting ON public.stock_locations;
CREATE TRIGGER trg_wms_location_nesting
  BEFORE INSERT OR UPDATE OF parent_location_id, structure_level, warehouse_id
  ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public._wms_assert_location_nesting();

-- 3. Cannot retire an occupied location --------------------------------------
CREATE OR REPLACE FUNCTION public._wms_guard_location_retire()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_qty numeric;
  v_tasks int;
BEGIN
  v_id := COALESCE(OLD.id, NEW.id);

  IF TG_OP = 'UPDATE'
     AND NOT (OLD.is_active = true AND NEW.is_active = false) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sum(abs(quantity)), 0) INTO v_qty
    FROM public.stock_quants WHERE location_id = v_id;
  IF v_qty > 0 THEN
    RAISE EXCEPTION 'location still holds stock — move it out first'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*) INTO v_tasks FROM public.wms_tasks
   WHERE (source_location_id = v_id OR destination_location_id = v_id)
     AND state NOT IN ('completed','cancelled');
  IF v_tasks > 0 THEN
    RAISE EXCEPTION 'location has % open warehouse task(s)', v_tasks
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_location_retire_guard ON public.stock_locations;
CREATE TRIGGER trg_wms_location_retire_guard
  BEFORE UPDATE OF is_active OR DELETE ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public._wms_guard_location_retire();

-- 4. Canonical location resolver ---------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_location_identity(
  p_business_id  uuid,
  p_code         text,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE(
  match_count      int,
  location_id      uuid,
  warehouse_id     uuid,
  code             text,
  name             text,
  structure_level  text,
  location_type    text,
  usage            text,
  barcode          text,
  is_active        boolean,
  is_putaway_target boolean,
  parent_location_id uuid,
  path             text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text := upper(btrim(coalesce(p_code, '')));
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);
  IF v_norm = '' THEN RETURN; END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT l.*,
           CASE WHEN upper(btrim(coalesce(l.barcode,''))) = v_norm THEN 0 ELSE 1 END AS rank
      FROM public.stock_locations l
     WHERE l.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
       AND (upper(btrim(coalesce(l.barcode,''))) = v_norm
            OR upper(btrim(l.code)) = v_norm)
  ), counted AS (
    SELECT (SELECT count(*)::int FROM hits) AS n, h.*
      FROM hits h ORDER BY h.rank, h.created_at LIMIT 1
  )
  SELECT c.n, c.id, c.warehouse_id, c.code, c.name, c.structure_level,
         c.location_type::text, c.usage::text, c.barcode, c.is_active,
         c.is_putaway_target, c.parent_location_id,
         (WITH RECURSIVE up AS (
            SELECT s.id, s.code, s.parent_location_id, 0 AS d
              FROM public.stock_locations s WHERE s.id = c.id
            UNION ALL
            SELECT s.id, s.code, s.parent_location_id, up.d + 1
              FROM public.stock_locations s JOIN up ON s.id = up.parent_location_id
          )
          SELECT string_agg(up.code, ' / ' ORDER BY up.d DESC) FROM up)
    FROM counted c;
END $$;

REVOKE ALL ON FUNCTION public.resolve_location_identity(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_location_identity(uuid, text, uuid) TO authenticated;

-- 5. Operational overview -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_location_overview(p_warehouse_id uuid)
RETURNS TABLE(
  location_id       uuid,
  on_hand_units     numeric,
  reserved_units    numeric,
  sku_count         int,
  lot_count         int,
  direct_on_hand    numeric,
  capacity_units    numeric,
  occupancy_pct     numeric,
  open_tasks        int,
  putaway_tasks     int,
  pick_tasks        int,
  count_tasks       int,
  last_movement_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business uuid;
BEGIN
  SELECT w.business_id INTO v_business FROM public.warehouses w WHERE w.id = p_warehouse_id;
  IF v_business IS NULL THEN RETURN; END IF;
  PERFORM public._wms_assert_business_access(v_business);

  RETURN QUERY
  WITH RECURSIVE loc AS (
    SELECT l.id, l.parent_location_id, l.capacity_max_units
      FROM public.stock_locations l WHERE l.warehouse_id = p_warehouse_id
  ),
  closure AS (
    SELECT l.id AS ancestor_id, l.id AS descendant_id FROM loc l
    UNION ALL
    SELECT c.ancestor_id, l.id
      FROM closure c JOIN loc l ON l.parent_location_id = c.descendant_id
  ),
  q AS (
    SELECT sq.location_id,
           sum(sq.quantity) AS qty,
           sum(coalesce(sq.reserved_quantity,0)) AS reserved,
           count(DISTINCT sq.product_id) AS skus,
           count(DISTINCT sq.lot_number) FILTER (WHERE sq.lot_number IS NOT NULL) AS lots
      FROM public.stock_quants sq
      JOIN loc l ON l.id = sq.location_id
     GROUP BY sq.location_id
  ),
  t AS (
    SELECT x.loc_id,
           count(*)::int AS open_n,
           count(*) FILTER (WHERE x.task_type::text ILIKE '%putaway%')::int AS pa,
           count(*) FILTER (WHERE x.task_type::text ILIKE '%pick%')::int AS pk,
           count(*) FILTER (WHERE x.task_type::text ILIKE '%count%')::int AS ct
      FROM (
        SELECT wt.source_location_id AS loc_id, wt.task_type FROM public.wms_tasks wt
         WHERE wt.warehouse_id = p_warehouse_id AND wt.state NOT IN ('completed','cancelled')
           AND wt.source_location_id IS NOT NULL
        UNION ALL
        SELECT wt.destination_location_id, wt.task_type FROM public.wms_tasks wt
         WHERE wt.warehouse_id = p_warehouse_id AND wt.state NOT IN ('completed','cancelled')
           AND wt.destination_location_id IS NOT NULL
      ) x
     GROUP BY x.loc_id
  ),
  m AS (
    SELECT x.loc_id, max(x.created_at) AS last_at
      FROM (
        SELECT sm.source_location_id AS loc_id, sm.created_at FROM public.stock_movements sm
         WHERE sm.source_location_id IS NOT NULL
        UNION ALL
        SELECT sm.destination_location_id, sm.created_at FROM public.stock_movements sm
         WHERE sm.destination_location_id IS NOT NULL
      ) x
      JOIN loc l ON l.id = x.loc_id
     GROUP BY x.loc_id
  )
  SELECT l.id,
         COALESCE(agg.qty, 0)::numeric,
         COALESCE(agg.reserved, 0)::numeric,
         COALESCE(agg.skus, 0)::int,
         COALESCE(agg.lots, 0)::int,
         COALESCE((SELECT q.qty FROM q WHERE q.location_id = l.id), 0)::numeric,
         l.capacity_max_units,
         CASE WHEN COALESCE(l.capacity_max_units, 0) > 0
              THEN round(100 * COALESCE(agg.qty,0) / l.capacity_max_units, 1)
              ELSE NULL END,
         COALESCE(agg.open_n, 0)::int,
         COALESCE(agg.pa, 0)::int,
         COALESCE(agg.pk, 0)::int,
         COALESCE(agg.ct, 0)::int,
         agg.last_at
    FROM loc l
    LEFT JOIN LATERAL (
      SELECT sum(q.qty) AS qty, sum(q.reserved) AS reserved,
             sum(q.skus) AS skus, sum(q.lots) AS lots,
             sum(t.open_n) AS open_n, sum(t.pa) AS pa, sum(t.pk) AS pk, sum(t.ct) AS ct,
             max(m.last_at) AS last_at
        FROM closure c
        LEFT JOIN q ON q.location_id = c.descendant_id
        LEFT JOIN t ON t.loc_id     = c.descendant_id
        LEFT JOIN m ON m.loc_id     = c.descendant_id
       WHERE c.ancestor_id = l.id
    ) agg ON TRUE;
END $$;

REVOKE ALL ON FUNCTION public.wms_location_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_location_overview(uuid) TO authenticated;

-- 6. Bulk structure generator --------------------------------------------------
-- p_levels: jsonb array, outermost first, e.g.
--   [{"level":"aisle","count":6,"prefix":"A","pad":2},
--    {"level":"rack","count":4,"prefix":"R","pad":2},
--    {"level":"bin","count":10,"prefix":"B","pad":3}]
CREATE OR REPLACE FUNCTION public.wms_generate_locations(
  p_warehouse_id uuid,
  p_parent_id    uuid,
  p_levels       jsonb,
  p_separator    text DEFAULT '-',
  p_code_prefix  text DEFAULT NULL,
  p_serpentine   boolean DEFAULT true,
  p_capacity     numeric DEFAULT NULL,
  p_barcode_auto boolean DEFAULT true,
  p_dry_run      boolean DEFAULT false
)
RETURNS TABLE(code text, level text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh          record;
  v_parent_code text := coalesce(p_code_prefix, '');
  v_spec        jsonb;
  v_i           int;
  v_n           int;
  v_pad         int;
  v_prefix      text;
  v_level       text;
  v_seq         int := 0;
  v_cur         jsonb;   -- array of {id, code}
  v_next        jsonb;
  v_node        jsonb;
  v_new_id      uuid;
  v_code        text;
  v_desc        boolean;
  v_idx         int;
BEGIN
  SELECT w.id, w.business_id, w.organization_id, w.branch_id INTO v_wh
    FROM public.warehouses w WHERE w.id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  PERFORM public._wms_assert_business_access(v_wh.business_id);

  IF p_parent_id IS NOT NULL THEN
    SELECT l.code INTO v_parent_code FROM public.stock_locations l
     WHERE l.id = p_parent_id AND l.warehouse_id = p_warehouse_id;
    IF v_parent_code IS NULL THEN RAISE EXCEPTION 'parent location not found'; END IF;
  END IF;

  v_cur := jsonb_build_array(jsonb_build_object('id', p_parent_id, 'code', v_parent_code));

  FOR v_idx IN 0 .. jsonb_array_length(p_levels) - 1 LOOP
    v_spec   := p_levels -> v_idx;
    v_level  := v_spec ->> 'level';
    v_n      := COALESCE((v_spec ->> 'count')::int, 0);
    v_pad    := COALESCE((v_spec ->> 'pad')::int, 2);
    v_prefix := COALESCE(v_spec ->> 'prefix', '');
    v_next   := '[]'::jsonb;

    IF v_n < 1 THEN RAISE EXCEPTION 'level % needs a positive count', v_level; END IF;

    FOR v_node IN SELECT * FROM jsonb_array_elements(v_cur) LOOP
      v_desc := p_serpentine AND (v_seq % 2 = 1);
      FOR v_i IN 1 .. v_n LOOP
        v_code := NULLIF(v_node ->> 'code', '')
                  || CASE WHEN COALESCE(v_node ->> 'code','') = '' THEN '' ELSE p_separator END
                  || v_prefix || lpad((CASE WHEN v_desc THEN v_n - v_i + 1 ELSE v_i END)::text, v_pad, '0');

        IF p_dry_run THEN
          RETURN QUERY SELECT v_code, v_level, false;
          v_next := v_next || jsonb_build_array(jsonb_build_object('id', NULL, 'code', v_code));
        ELSE
          INSERT INTO public.stock_locations (
            warehouse_id, parent_location_id, organization_id, business_id, branch_id,
            code, name, location_type, usage, structure_level, barcode,
            pick_sequence, capacity_max_units, is_active, is_default,
            is_putaway_target, created_by
          ) VALUES (
            p_warehouse_id,
            NULLIF(v_node ->> 'id','')::uuid,
            v_wh.organization_id, v_wh.business_id, v_wh.branch_id,
            v_code, v_code,
            'internal'::location_type_enum,
            CASE WHEN v_level = 'bin' THEN 'pick' ELSE 'storage' END::location_usage_enum,
            v_level,
            CASE WHEN p_barcode_auto THEN v_code ELSE NULL END,
            (v_seq + v_i) * 10,
            CASE WHEN v_level = 'bin' THEN p_capacity ELSE NULL END,
            true, false,
            v_level = 'bin',
            auth.uid()
          )
          ON CONFLICT DO NOTHING
          RETURNING id INTO v_new_id;

          IF v_new_id IS NULL THEN
            SELECT l.id INTO v_new_id FROM public.stock_locations l
             WHERE l.warehouse_id = p_warehouse_id AND l.code = v_code;
            RETURN QUERY SELECT v_code, v_level, false;
          ELSE
            RETURN QUERY SELECT v_code, v_level, true;
          END IF;
          v_next := v_next || jsonb_build_array(jsonb_build_object('id', v_new_id, 'code', v_code));
        END IF;
      END LOOP;
      v_seq := v_seq + v_n;
    END LOOP;

    v_cur := v_next;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.wms_generate_locations(uuid, uuid, jsonb, text, text, boolean, numeric, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_generate_locations(uuid, uuid, jsonb, text, text, boolean, numeric, boolean, boolean) TO authenticated;