-- =====================================================================
-- Phase 2 — Wave strategy engine.
-- Waves stop being "whatever the supervisor ticked". A strategy declares
-- which demand it claims, how that demand is grouped into waves, how big a
-- wave may get and which departure it serves.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.wms_wave_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'batch',
  is_active boolean NOT NULL DEFAULT true,
  sequence integer NOT NULL DEFAULT 100,
  -- Grouping: any of customer | ship_date | carrier | zone | priority.
  -- An empty array means "one wave for everything this strategy claims".
  group_by text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Selection criteria, all optional:
  --   {"customer_ids":[],"carrier_ids":[],"order_statuses":[],
  --    "ship_within_days":n,"min_priority":n,"temp_regimes":[]}
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_orders_per_wave integer NOT NULL DEFAULT 25,
  max_lines_per_wave integer NOT NULL DEFAULT 250,
  max_units_per_wave numeric,
  cutoff_offset_minutes integer,
  active_from time,
  active_to time,
  auto_plan boolean NOT NULL DEFAULT false,
  auto_release boolean NOT NULL DEFAULT false,
  wave_priority integer NOT NULL DEFAULT 50,
  task_priority integer NOT NULL DEFAULT 90,
  minutes_per_line numeric NOT NULL DEFAULT 1.5,
  minutes_per_unit numeric NOT NULL DEFAULT 0.1,
  units_per_carton numeric NOT NULL DEFAULT 12,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_wave_strategies_kind_chk CHECK (kind IN (
    'carrier','route','zone','customer','priority','express','temperature',
    'replenishment','truck','dock','batch','consolidation'
  ))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_wave_strategies TO authenticated;
GRANT ALL ON public.wms_wave_strategies TO service_role;

ALTER TABLE public.wms_wave_strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wave strategies readable by business members"
  ON public.wms_wave_strategies FOR SELECT TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wave strategies writable by business members"
  ON public.wms_wave_strategies FOR INSERT TO authenticated
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wave strategies updatable by business members"
  ON public.wms_wave_strategies FOR UPDATE TO authenticated
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wave strategies deletable by business members"
  ON public.wms_wave_strategies FOR DELETE TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_wms_wave_strategies_touch
  BEFORE UPDATE ON public.wms_wave_strategies
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_pick_waves_updated_at();

CREATE INDEX IF NOT EXISTS idx_wms_wave_strategies_wh
  ON public.wms_wave_strategies(warehouse_id, is_active, sequence);

ALTER TABLE public.wms_pick_waves
  DROP CONSTRAINT IF EXISTS wms_pick_waves_strategy_id_fkey;
ALTER TABLE public.wms_pick_waves
  ADD CONSTRAINT wms_pick_waves_strategy_id_fkey
  FOREIGN KEY (strategy_id) REFERENCES public.wms_wave_strategies(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Demand: every open outbound line and whether it can be waved.
-- One place decides eligibility, so the tower, the planner and alerting
-- cannot disagree about what is waveable.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_wave_demand(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE (
  sales_order_id uuid,
  so_number text,
  contact_id uuid,
  customer_name text,
  expected_date date,
  order_status text,
  carrier_id uuid,
  open_lines integer,
  open_units numeric,
  covered_units numeric,
  eligible boolean,
  block_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public._wms_assert_business_access(p_business_id))
  SELECT
    so.id,
    so.so_number,
    so.contact_id,
    c.name,
    so.expected_date,
    so.status,
    dn.carrier_id,
    count(soi.id)::int                                   AS open_lines,
    COALESCE(sum(soi.qty_open), 0)                       AS open_units,
    COALESCE(sum(LEAST(soi.qty_open, COALESCE(av.available, 0))), 0) AS covered_units,
    CASE
      WHEN so.is_locked THEN false
      WHEN COALESCE(sum(LEAST(soi.qty_open, COALESCE(av.available,0))), 0) <= 0 THEN false
      ELSE true
    END,
    CASE
      WHEN so.is_locked THEN 'order_locked'
      WHEN COALESCE(sum(LEAST(soi.qty_open, COALESCE(av.available,0))), 0) <= 0 THEN 'no_stock'
      WHEN COALESCE(sum(LEAST(soi.qty_open, COALESCE(av.available,0))), 0)
           < COALESCE(sum(soi.qty_open), 0) THEN 'partial_stock'
      ELSE NULL
    END
  FROM guard, public.sales_orders so
  JOIN LATERAL (
    SELECT i.id, i.product_id,
           GREATEST(COALESCE(i.quantity,0) - COALESCE(i.quantity_fulfilled,0), 0) AS qty_open
    FROM public.sales_order_items i
    WHERE i.sales_order_id = so.id
      AND GREATEST(COALESCE(i.quantity,0) - COALESCE(i.quantity_fulfilled,0), 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.wms_pick_wave_lines wl
        JOIN public.wms_pick_waves ww ON ww.id = wl.wave_id
        WHERE wl.sales_order_item_id = i.id
          AND ww.state NOT IN ('cancelled','archived')
      )
  ) soi ON true
  LEFT JOIN LATERAL (
    SELECT sum(GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0)) AS available
    FROM public.stock_quants sq
    JOIN public.stock_locations sl ON sl.id = sq.location_id
    WHERE sq.product_id = soi.product_id
      AND sl.is_active
      AND COALESCE(sl.is_blocked,false) = false
      AND (p_warehouse_id IS NULL OR sl.warehouse_id = p_warehouse_id)
  ) av ON true
  LEFT JOIN public.contacts c ON c.id = so.contact_id
  LEFT JOIN LATERAL (
    SELECT d.carrier_id FROM public.delivery_notes d
    WHERE d.sales_order_id = so.id ORDER BY d.created_at DESC LIMIT 1
  ) dn ON true
  WHERE so.business_id = p_business_id
    AND so.status IN ('confirmed','approved','processing','open')
  GROUP BY so.id, so.so_number, so.contact_id, c.name, so.expected_date,
           so.status, so.is_locked, dn.carrier_id
  ORDER BY so.expected_date NULLS LAST, so.order_date;
$$;

GRANT EXECUTE ON FUNCTION public.wms_wave_demand(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- Planning: build PLANNED waves from a strategy. Nothing here touches
-- stock or tasks — planning is a proposal, release is the commitment.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_plan_waves(
  p_warehouse_id uuid,
  p_strategy_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wh        record;
  v_strategy  public.wms_wave_strategies;
  v_group     record;
  v_line      record;
  v_wave_id   uuid;
  v_wave_no   text;
  v_orders    int;
  v_lines     int;
  v_units     numeric;
  v_waves     jsonb := '[]'::jsonb;
  v_created   int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id INTO v_wh
  FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id USING ERRCODE='P0002'; END IF;
  PERFORM public._wms_assert_business_access(v_wh.business_id);

  FOR v_strategy IN
    SELECT * FROM public.wms_wave_strategies
    WHERE warehouse_id = p_warehouse_id
      AND is_active
      AND (p_strategy_id IS NULL OR id = p_strategy_id)
      AND (active_from IS NULL OR localtime >= active_from)
      AND (active_to   IS NULL OR localtime <= active_to)
    ORDER BY sequence, created_at
  LOOP
    FOR v_group IN
      WITH claimed AS (
        SELECT
          soi.id AS item_id, soi.sales_order_id, soi.product_id, soi.lot_number,
          GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0), 0) AS qty_open,
          so.contact_id, so.expected_date, dn.carrier_id,
          zone.zone_id
        FROM public.sales_order_items soi
        JOIN public.sales_orders so ON so.id = soi.sales_order_id
        LEFT JOIN LATERAL (
          SELECT d.carrier_id FROM public.delivery_notes d
          WHERE d.sales_order_id = so.id ORDER BY d.created_at DESC LIMIT 1
        ) dn ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(sl.parent_location_id, sl.id) AS zone_id
          FROM public.stock_quants sq
          JOIN public.stock_locations sl ON sl.id = sq.location_id
          WHERE sq.product_id = soi.product_id
            AND sl.warehouse_id = p_warehouse_id
            AND sl.is_active
            AND (sq.quantity - COALESCE(sq.reserved_quantity,0)) > 0
          ORDER BY sl.pick_sequence NULLS LAST
          LIMIT 1
        ) zone ON true
        WHERE so.business_id = v_wh.business_id
          AND COALESCE(so.is_locked, false) = false
          AND so.status IN ('confirmed','approved','processing','open')
          AND GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0), 0) > 0
          AND NOT EXISTS (
            SELECT 1 FROM public.wms_pick_wave_lines wl
            JOIN public.wms_pick_waves ww ON ww.id = wl.wave_id
            WHERE wl.sales_order_item_id = soi.id
              AND ww.state NOT IN ('cancelled','archived')
          )
          -- criteria
          AND (
            NOT (v_strategy.criteria ? 'customer_ids')
            OR so.contact_id::text IN (
              SELECT jsonb_array_elements_text(v_strategy.criteria->'customer_ids')
            )
          )
          AND (
            NOT (v_strategy.criteria ? 'carrier_ids')
            OR dn.carrier_id::text IN (
              SELECT jsonb_array_elements_text(v_strategy.criteria->'carrier_ids')
            )
          )
          AND (
            NOT (v_strategy.criteria ? 'order_statuses')
            OR so.status IN (
              SELECT jsonb_array_elements_text(v_strategy.criteria->'order_statuses')
            )
          )
          AND (
            NOT (v_strategy.criteria ? 'ship_within_days')
            OR so.expected_date IS NULL
            OR so.expected_date <= (current_date
                 + ((v_strategy.criteria->>'ship_within_days')::int) * INTERVAL '1 day')
          )
      )
      SELECT
        CASE WHEN 'customer'  = ANY(v_strategy.group_by) THEN contact_id::text  ELSE '*' END AS k_customer,
        CASE WHEN 'ship_date' = ANY(v_strategy.group_by) THEN expected_date::text ELSE '*' END AS k_date,
        CASE WHEN 'carrier'   = ANY(v_strategy.group_by) THEN carrier_id::text   ELSE '*' END AS k_carrier,
        CASE WHEN 'zone'      = ANY(v_strategy.group_by) THEN zone_id::text      ELSE '*' END AS k_zone,
        min(contact_id::text)  AS any_customer,
        min(carrier_id::text)  AS any_carrier,
        min(expected_date)     AS any_date,
        count(DISTINCT sales_order_id)::int AS order_count,
        count(*)::int                       AS line_count,
        sum(qty_open)                       AS unit_count,
        array_agg(item_id)                  AS item_ids
      FROM claimed
      GROUP BY 1,2,3,4
      HAVING count(*) > 0
    LOOP
      v_wave_no := 'WAVE-' || to_char(now(), 'YYMMDD') || '-'
                   || upper(substr(md5(gen_random_uuid()::text), 1, 5));
      v_orders := 0; v_lines := 0; v_units := 0;

      INSERT INTO public.wms_pick_waves (
        organization_id, business_id, branch_id, warehouse_id,
        wave_number, state, strategy, strategy_id, notes, created_by,
        carrier_id, priority, cutoff_at, planned_release_at,
        estimated_lines, estimated_units, estimated_cartons, estimated_pick_minutes
      ) VALUES (
        v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
        v_wave_no, 'planned', v_strategy.kind, v_strategy.id,
        'Planned by strategy ' || v_strategy.name, auth.uid(),
        NULLIF(v_group.any_carrier, '')::uuid,
        v_strategy.wave_priority,
        CASE WHEN v_strategy.cutoff_offset_minutes IS NOT NULL
             THEN now() + (v_strategy.cutoff_offset_minutes || ' minutes')::interval END,
        now(),
        v_group.line_count,
        v_group.unit_count,
        CEIL(v_group.unit_count / GREATEST(v_strategy.units_per_carton, 1))::int,
        ROUND(v_group.line_count * v_strategy.minutes_per_line
              + v_group.unit_count * v_strategy.minutes_per_unit, 1)
      ) RETURNING id INTO v_wave_id;

      FOR v_line IN
        SELECT soi.id AS item_id, soi.sales_order_id, soi.product_id, soi.lot_number,
               GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0), 0) AS qty_open
        FROM public.sales_order_items soi
        WHERE soi.id = ANY(v_group.item_ids)
        ORDER BY soi.sales_order_id
      LOOP
        EXIT WHEN v_lines >= v_strategy.max_lines_per_wave;
        EXIT WHEN v_strategy.max_units_per_wave IS NOT NULL
                  AND v_units >= v_strategy.max_units_per_wave;

        INSERT INTO public.wms_pick_wave_lines (
          organization_id, business_id, branch_id,
          wave_id, sales_order_id, sales_order_item_id,
          product_id, lot_number, quantity_ordered
        ) VALUES (
          v_wh.organization_id, v_wh.business_id, v_wh.branch_id,
          v_wave_id, v_line.sales_order_id, v_line.item_id,
          v_line.product_id, v_line.lot_number, v_line.qty_open
        ) ON CONFLICT DO NOTHING;

        v_lines := v_lines + 1;
        v_units := v_units + v_line.qty_open;
      END LOOP;

      SELECT count(DISTINCT sales_order_id) INTO v_orders
      FROM public.wms_pick_wave_lines WHERE wave_id = v_wave_id;

      IF v_lines = 0 THEN
        DELETE FROM public.wms_pick_waves WHERE id = v_wave_id;
        CONTINUE;
      END IF;

      UPDATE public.wms_pick_waves
      SET estimated_lines = v_lines,
          estimated_units = v_units,
          estimated_cartons = CEIL(v_units / GREATEST(v_strategy.units_per_carton,1))::int,
          estimated_pick_minutes = ROUND(v_lines * v_strategy.minutes_per_line
                                         + v_units * v_strategy.minutes_per_unit, 1)
      WHERE id = v_wave_id;

      v_created := v_created + 1;
      v_waves := v_waves || jsonb_build_object(
        'wave_id', v_wave_id, 'wave_number', v_wave_no,
        'strategy', v_strategy.name, 'orders', v_orders,
        'lines', v_lines, 'units', v_units
      );

      PERFORM public._wms_emit_outbox(
        'warehouse.wave.planned',
        'wms.wave:' || v_wave_id::text || ':planned',
        v_wh.organization_id, v_wh.business_id,
        jsonb_build_object(
          'aggregate_id', v_wave_id, 'warehouse_id', p_warehouse_id,
          'branch_id', v_wh.branch_id, 'actor_id', auth.uid(),
          'occurred_at', now(), 'strategy_id', v_strategy.id
        )
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('waves_created', v_created, 'waves', v_waves);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_plan_waves(uuid, uuid) TO authenticated;