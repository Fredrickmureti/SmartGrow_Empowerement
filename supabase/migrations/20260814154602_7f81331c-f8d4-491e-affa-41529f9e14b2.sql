CREATE OR REPLACE FUNCTION public.run_replenishment_planning(
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_trigger_type text DEFAULT 'manual'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_run_id uuid;
  v_created integer := 0;
  v_stockouts integer := 0;
  v_critical integer := 0;
  v_low integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_business_id IS NULL OR NOT public.user_can_access_business(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied to business %', p_business_id;
  END IF;

  IF p_branch_id IS NOT NULL AND NOT public.can_access_branch(v_uid, p_branch_id) THEN
    RAISE EXCEPTION 'Access denied to branch %', p_branch_id;
  END IF;

  IF p_trigger_type NOT IN ('manual','scheduled','event') THEN
    p_trigger_type := 'manual';
  END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Business not found';
  END IF;

  INSERT INTO public.replenishment_runs(
    organization_id, business_id, branch_id, run_type, triggered_by, status
  ) VALUES (
    v_org_id, p_business_id, p_branch_id, p_trigger_type, v_uid, 'running'
  ) RETURNING id INTO v_run_id;

  WITH rules AS (
    SELECT r.*
    FROM public.product_reorder_rules r
    WHERE r.business_id = p_business_id
      AND r.is_active = true
      AND (p_branch_id IS NULL OR r.branch_id IS NULL OR r.branch_id = p_branch_id)
  ),
  -- Planning grain: one row per (rule product, branch that actually holds the
  -- product within scope). Rules with no stock anywhere still plan once at the
  -- run's scope so stockouts remain visible.
  targets AS (
    SELECT DISTINCT
      r.product_id,
      COALESCE(r.branch_id, b.branch_id, p_branch_id) AS branch_id
    FROM rules r
    LEFT JOIN LATERAL (
      SELECT q.branch_id
        FROM public.stock_quants q
       WHERE q.product_id = r.product_id
         AND q.business_id = p_business_id
         AND (p_branch_id IS NULL OR q.branch_id = p_branch_id)
         AND (r.branch_id IS NULL OR q.branch_id = r.branch_id)
       GROUP BY q.branch_id
    ) b ON true
  ),
  -- ADR 0142: availability comes from the one engine. Never recompute
  -- `quantity - reserved_quantity` here.
  avail AS (
    SELECT t.product_id,
           t.branch_id,
           a.on_hand,
           a.reserved,
           a.available
      FROM targets t
      CROSS JOIN LATERAL public.resolve_stock_availability_batch(
        ARRAY[t.product_id]::uuid[], p_business_id, t.branch_id) a
  ),
  calc AS (
    SELECT
      r.product_id,
      s.branch_id,
      GREATEST(0, s.on_hand)   AS on_hand,
      GREATEST(0, s.reserved)  AS reserved,
      GREATEST(0, s.available) AS available,
      COALESCE(i.incoming, 0)  AS incoming,
      COALESCE(v.per_week, 0)  AS velocity_per_week,
      COALESCE(r.safety_stock, 0) AS safety_stock,
      COALESCE(r.lead_time_days, 7) AS lead_time_days,
      COALESCE(r.moq, 0) AS moq,
      COALESCE(NULLIF(r.pack_size, 0), 1) AS pack_size,
      r.reorder_quantity,
      r.min_quantity AS reorder_point,
      r.preferred_supplier_id AS preferred_vendor_id
    FROM rules r
    JOIN avail s
      ON s.product_id = r.product_id
     AND (r.branch_id IS NULL OR s.branch_id IS NOT DISTINCT FROM r.branch_id)
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(es.expected_quantity), 0)::numeric AS incoming
        FROM public.inventory_expected_supply es
       WHERE es.business_id = p_business_id
         AND es.product_id = r.product_id
         AND (s.branch_id IS NULL OR es.branch_id = s.branch_id)
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT (COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN -sm.quantity ELSE 0 END), 0) / 4.0)::numeric AS per_week
        FROM public.stock_movements sm
       WHERE sm.business_id = p_business_id
         AND sm.product_id = r.product_id
         AND sm.movement_date >= now() - interval '28 days'
         AND (s.branch_id IS NULL OR sm.branch_id = s.branch_id)
    ) v ON true
  ),
  computed AS (
    SELECT
      c.*,
      (c.velocity_per_week / 7.0) * c.lead_time_days AS forecast_lead_demand
    FROM calc c
  ),
  final AS (
    SELECT
      cm.*,
      GREATEST(0, cm.safety_stock + cm.forecast_lead_demand - cm.available - cm.incoming) AS raw_need,
      CASE
        WHEN cm.available <= 0 THEN 'stockout'
        WHEN cm.velocity_per_week > 0
             AND (cm.available / NULLIF(cm.velocity_per_week / 7.0, 0)) < 7
          THEN 'critical'
        WHEN cm.velocity_per_week > 0
             AND (cm.available / NULLIF(cm.velocity_per_week / 7.0, 0)) < 14
          THEN 'low'
        ELSE 'planned'
      END AS urgency
    FROM computed cm
  )
  INSERT INTO public.procurement_recommendations(
    run_id, organization_id, business_id, branch_id, product_id,
    on_hand, reserved, incoming, velocity_per_week, safety_stock, lead_time_days,
    net_requirement, suggested_qty, suggested_source, preferred_vendor_id, urgency,
    needed_by, explanation, status
  )
  SELECT
    v_run_id, v_org_id, p_business_id, f.branch_id, f.product_id,
    f.on_hand, f.reserved, f.incoming, f.velocity_per_week, f.safety_stock, f.lead_time_days,
    f.raw_need,
    CASE
      WHEN f.raw_need <= 0 THEN 0
      ELSE GREATEST(f.moq, CEIL(f.raw_need / f.pack_size) * f.pack_size)
    END,
    'buy',
    f.preferred_vendor_id,
    f.urgency,
    (current_date + (f.lead_time_days || ' days')::interval)::date,
    jsonb_build_object(
      'on_hand', f.on_hand,
      'reserved', f.reserved,
      'available', f.available,
      'incoming', f.incoming,
      'velocity_per_week', f.velocity_per_week,
      'safety_stock', f.safety_stock,
      'lead_time_days', f.lead_time_days,
      'moq', f.moq,
      'pack_size', f.pack_size,
      'forecast_lead_demand', f.forecast_lead_demand,
      'reorder_point', f.reorder_point,
      'raw_need', f.raw_need,
      'availability_source', 'resolve_stock_availability_batch'
    ),
    'open'
  FROM final f
  WHERE f.raw_need > 0
     OR f.urgency IN ('stockout','critical');

  GET DIAGNOSTICS v_created = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE urgency = 'stockout'),
    COUNT(*) FILTER (WHERE urgency = 'critical'),
    COUNT(*) FILTER (WHERE urgency = 'low')
  INTO v_stockouts, v_critical, v_low
  FROM public.procurement_recommendations
  WHERE run_id = v_run_id;

  UPDATE public.replenishment_runs
  SET status = 'completed',
      completed_at = now(),
      recommendations_created = v_created,
      stockouts = COALESCE(v_stockouts, 0),
      critical = COALESCE(v_critical, 0),
      low = COALESCE(v_low, 0)
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'recommendations_created', v_created,
    'stockouts', COALESCE(v_stockouts, 0),
    'critical', COALESCE(v_critical, 0),
    'low', COALESCE(v_low, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.run_replenishment_planning(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_replenishment_planning(uuid, uuid, text) TO authenticated, service_role;