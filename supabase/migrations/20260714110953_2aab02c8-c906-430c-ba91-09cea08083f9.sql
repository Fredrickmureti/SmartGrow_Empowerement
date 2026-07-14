
-- 1) Extend product_reorder_rules (lead_time_days already exists)
ALTER TABLE public.product_reorder_rules
  ADD COLUMN IF NOT EXISTS safety_stock numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS moq numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pack_size numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_strategy text NOT NULL DEFAULT 'buy_only'
    CHECK (source_strategy IN ('buy_only','prefer_transfer','prefer_manufacture'));

-- 2) replenishment_runs
CREATE TABLE IF NOT EXISTS public.replenishment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  run_type text NOT NULL DEFAULT 'manual' CHECK (run_type IN ('manual','scheduled','event')),
  triggered_by uuid,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  recommendations_created integer NOT NULL DEFAULT 0,
  stockouts integer NOT NULL DEFAULT 0,
  critical integer NOT NULL DEFAULT 0,
  low integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.replenishment_runs TO authenticated;
GRANT ALL ON public.replenishment_runs TO service_role;

ALTER TABLE public.replenishment_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS replenishment_runs_select ON public.replenishment_runs;
CREATE POLICY replenishment_runs_select ON public.replenishment_runs
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS replenishment_runs_write ON public.replenishment_runs;
CREATE POLICY replenishment_runs_write ON public.replenishment_runs
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_repl_runs_business_started
  ON public.replenishment_runs(business_id, started_at DESC);

-- 3) procurement_recommendations
CREATE TABLE IF NOT EXISTS public.procurement_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.replenishment_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE SET NULL,
  on_hand numeric NOT NULL DEFAULT 0,
  reserved numeric NOT NULL DEFAULT 0,
  incoming numeric NOT NULL DEFAULT 0,
  velocity_per_week numeric NOT NULL DEFAULT 0,
  safety_stock numeric NOT NULL DEFAULT 0,
  lead_time_days integer NOT NULL DEFAULT 0,
  net_requirement numeric NOT NULL DEFAULT 0,
  suggested_qty numeric NOT NULL DEFAULT 0,
  suggested_source text NOT NULL DEFAULT 'buy'
    CHECK (suggested_source IN ('buy','transfer','manufacture')),
  preferred_vendor_id uuid,
  urgency text NOT NULL CHECK (urgency IN ('stockout','critical','low','planned')),
  needed_by date,
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','snoozed','dismissed','actioned')),
  actioned_ref_type text,
  actioned_ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.procurement_recommendations TO authenticated;
GRANT ALL ON public.procurement_recommendations TO service_role;

ALTER TABLE public.procurement_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pr_select ON public.procurement_recommendations;
CREATE POLICY pr_select ON public.procurement_recommendations
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

DROP POLICY IF EXISTS pr_write ON public.procurement_recommendations;
CREATE POLICY pr_write ON public.procurement_recommendations
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE INDEX IF NOT EXISTS idx_pr_run ON public.procurement_recommendations(run_id);
CREATE INDEX IF NOT EXISTS idx_pr_business_status
  ON public.procurement_recommendations(business_id, status);
CREATE INDEX IF NOT EXISTS idx_pr_urgency ON public.procurement_recommendations(urgency);

CREATE OR REPLACE FUNCTION public.touch_procurement_recommendations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_touch ON public.procurement_recommendations;
CREATE TRIGGER trg_pr_touch BEFORE UPDATE ON public.procurement_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.touch_procurement_recommendations_updated_at();

-- 4) Engine function
CREATE OR REPLACE FUNCTION public.run_replenishment_planning(
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_trigger_type text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  stock_agg AS (
    SELECT ws.product_id, ws.branch_id,
           COALESCE(SUM(ws.quantity), 0)::numeric AS on_hand,
           COALESCE(SUM(ws.reserved_quantity), 0)::numeric AS reserved
    FROM public.warehouse_stock ws
    WHERE ws.business_id = p_business_id
      AND (p_branch_id IS NULL OR ws.branch_id = p_branch_id)
    GROUP BY ws.product_id, ws.branch_id
  ),
  incoming_agg AS (
    SELECT poi.product_id, po.branch_id,
           COALESCE(SUM(poi.quantity - COALESCE(poi.quantity_received, 0)), 0)::numeric AS incoming
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.business_id = p_business_id
      AND po.status IN ('draft','sent','partial_received')
      AND (p_branch_id IS NULL OR po.branch_id = p_branch_id)
    GROUP BY poi.product_id, po.branch_id
  ),
  velocity_agg AS (
    SELECT sm.product_id, sm.branch_id,
           (COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN -sm.quantity ELSE 0 END), 0) / 4.0)::numeric AS per_week
    FROM public.stock_movements sm
    WHERE sm.business_id = p_business_id
      AND sm.movement_date >= now() - interval '28 days'
      AND (p_branch_id IS NULL OR sm.branch_id = p_branch_id)
    GROUP BY sm.product_id, sm.branch_id
  ),
  calc AS (
    SELECT
      r.product_id,
      COALESCE(r.branch_id, s.branch_id) AS branch_id,
      COALESCE(s.on_hand, 0) AS on_hand,
      COALESCE(s.reserved, 0) AS reserved,
      COALESCE(i.incoming, 0) AS incoming,
      COALESCE(v.per_week, 0) AS velocity_per_week,
      COALESCE(r.safety_stock, 0) AS safety_stock,
      COALESCE(r.lead_time_days, 7) AS lead_time_days,
      COALESCE(r.moq, 0) AS moq,
      COALESCE(NULLIF(r.pack_size, 0), 1) AS pack_size,
      r.reorder_quantity,
      r.min_quantity AS reorder_point,
      r.preferred_supplier_id AS preferred_vendor_id
    FROM rules r
    LEFT JOIN stock_agg s
      ON s.product_id = r.product_id
     AND (r.branch_id IS NULL OR s.branch_id = r.branch_id)
    LEFT JOIN incoming_agg i
      ON i.product_id = r.product_id
     AND (r.branch_id IS NULL OR i.branch_id = r.branch_id)
    LEFT JOIN velocity_agg v
      ON v.product_id = r.product_id
     AND (r.branch_id IS NULL OR v.branch_id = r.branch_id)
  ),
  computed AS (
    SELECT
      c.*,
      GREATEST(0, c.on_hand - GREATEST(0, c.reserved)) AS available,
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
      'raw_need', f.raw_need
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
$$;

GRANT EXECUTE ON FUNCTION public.run_replenishment_planning(uuid, uuid, text) TO authenticated;
