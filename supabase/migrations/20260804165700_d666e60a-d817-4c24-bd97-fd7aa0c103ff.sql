
-- ============================================================
-- Putaway Strategy Engine — Phase 1
-- ============================================================

-- 1) Strategy type enum
DO $$ BEGIN
  CREATE TYPE public.wms_putaway_strategy_type AS ENUM (
    'fixed_bin','consolidate','same_category','fefo_zone','hazmat_zone',
    'cold_chain','heavy_zone','velocity_slot','empty_bin','nearest',
    'overflow','bulk','general_priority'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Location storage attributes
ALTER TABLE public.stock_locations
  ADD COLUMN IF NOT EXISTS temp_regime text,
  ADD COLUMN IF NOT EXISTS hazmat_classes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS storage_role text,
  ADD COLUMN IF NOT EXISTS capacity_max_volume numeric,
  ADD COLUMN IF NOT EXISTS allow_mixed_products boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_mixed_lots boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS ground_level boolean NOT NULL DEFAULT false;

-- 3) Strategy configuration
CREATE TABLE IF NOT EXISTS public.wms_putaway_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name text NOT NULL,
  strategy_type public.wms_putaway_strategy_type NOT NULL,
  sequence integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_putaway_strategies TO authenticated;
GRANT ALL ON public.wms_putaway_strategies TO service_role;
ALTER TABLE public.wms_putaway_strategies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_putaway_strategies_select ON public.wms_putaway_strategies;
CREATE POLICY wms_putaway_strategies_select ON public.wms_putaway_strategies
  FOR SELECT TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS wms_putaway_strategies_write ON public.wms_putaway_strategies;
CREATE POLICY wms_putaway_strategies_write ON public.wms_putaway_strategies
  FOR ALL TO authenticated
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_wms_putaway_strategies_wh
  ON public.wms_putaway_strategies(warehouse_id, sequence) WHERE is_active;

-- 4) Fixed bins
CREATE TABLE IF NOT EXISTS public.wms_product_fixed_bins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, product_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_product_fixed_bins TO authenticated;
GRANT ALL ON public.wms_product_fixed_bins TO service_role;
ALTER TABLE public.wms_product_fixed_bins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_product_fixed_bins_select ON public.wms_product_fixed_bins;
CREATE POLICY wms_product_fixed_bins_select ON public.wms_product_fixed_bins
  FOR SELECT TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS wms_product_fixed_bins_write ON public.wms_product_fixed_bins;
CREATE POLICY wms_product_fixed_bins_write ON public.wms_product_fixed_bins
  FOR ALL TO authenticated
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

-- 5) Product storage profile
CREATE TABLE IF NOT EXISTS public.wms_product_storage_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  hazmat_class text,
  temp_regime text,
  unit_weight numeric,
  unit_volume numeric,
  velocity_class text,
  storage_type text,
  requires_ground_level boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_product_storage_profiles TO authenticated;
GRANT ALL ON public.wms_product_storage_profiles TO service_role;
ALTER TABLE public.wms_product_storage_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_product_storage_profiles_select ON public.wms_product_storage_profiles;
CREATE POLICY wms_product_storage_profiles_select ON public.wms_product_storage_profiles
  FOR SELECT TO authenticated
  USING (user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS wms_product_storage_profiles_write ON public.wms_product_storage_profiles;
CREATE POLICY wms_product_storage_profiles_write ON public.wms_product_storage_profiles
  FOR ALL TO authenticated
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

-- 6) Suggestion audit gains strategy provenance
ALTER TABLE public.wms_putaway_suggestions
  ADD COLUMN IF NOT EXISTS strategy text,
  ADD COLUMN IF NOT EXISTS feasible_qty numeric,
  ADD COLUMN IF NOT EXISTS score numeric;

-- 7) touch triggers
CREATE OR REPLACE FUNCTION public._wms_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS t_touch ON public.wms_putaway_strategies;
CREATE TRIGGER t_touch BEFORE UPDATE ON public.wms_putaway_strategies
  FOR EACH ROW EXECUTE FUNCTION public._wms_touch_updated_at();
DROP TRIGGER IF EXISTS t_touch ON public.wms_product_fixed_bins;
CREATE TRIGGER t_touch BEFORE UPDATE ON public.wms_product_fixed_bins
  FOR EACH ROW EXECUTE FUNCTION public._wms_touch_updated_at();
DROP TRIGGER IF EXISTS t_touch ON public.wms_product_storage_profiles;
CREATE TRIGGER t_touch BEFORE UPDATE ON public.wms_product_storage_profiles
  FOR EACH ROW EXECUTE FUNCTION public._wms_touch_updated_at();

-- 8) Occupancy + feasibility
CREATE OR REPLACE FUNCTION public.wms_location_occupancy(p_location_id uuid)
RETURNS TABLE(units numeric, weight numeric, volume numeric, distinct_products integer, distinct_lots integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(q.quantity),0),
         COALESCE(SUM(q.quantity * COALESCE(sp.unit_weight,0)),0),
         COALESCE(SUM(q.quantity * COALESCE(sp.unit_volume,0)),0),
         COUNT(DISTINCT q.product_id)::int,
         COUNT(DISTINCT q.lot_number)::int
  FROM public.stock_quants q
  LEFT JOIN public.wms_product_storage_profiles sp ON sp.product_id = q.product_id
  WHERE q.location_id = p_location_id AND COALESCE(q.quantity,0) > 0;
$$;

REVOKE ALL ON FUNCTION public.wms_location_occupancy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_location_occupancy(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_location_feasible(
  p_location_id uuid, p_product_id uuid, p_quantity numeric, p_lot_number text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc public.stock_locations%ROWTYPE;
  v_prof public.wms_product_storage_profiles%ROWTYPE;
  v_occ record;
  v_fit numeric := p_quantity;
  v_cap numeric;
BEGIN
  SELECT * INTO v_loc FROM public.stock_locations WHERE id = p_location_id;
  IF v_loc.id IS NULL THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'location_missing', 'feasible_qty', 0);
  END IF;
  IF NOT v_loc.is_active THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'location_inactive', 'feasible_qty', 0);
  END IF;
  IF COALESCE(v_loc.is_blocked,false) THEN
    RETURN jsonb_build_object('feasible', false, 'reason', COALESCE('blocked: '||v_loc.blocked_reason,'location_blocked'), 'feasible_qty', 0);
  END IF;

  SELECT * INTO v_prof FROM public.wms_product_storage_profiles WHERE product_id = p_product_id;
  SELECT * INTO v_occ FROM public.wms_location_occupancy(p_location_id);

  -- temperature regime
  IF v_prof.temp_regime IS NOT NULL AND v_loc.temp_regime IS NOT NULL
     AND v_prof.temp_regime <> v_loc.temp_regime THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'temp_regime_mismatch', 'feasible_qty', 0);
  END IF;
  IF v_prof.temp_regime IS NOT NULL AND v_prof.temp_regime <> 'ambient' AND v_loc.temp_regime IS NULL THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'temp_controlled_bin_required', 'feasible_qty', 0);
  END IF;

  -- hazard class
  IF v_prof.hazmat_class IS NOT NULL
     AND NOT (v_prof.hazmat_class = ANY (COALESCE(v_loc.hazmat_classes, ARRAY[]::text[]))) THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'hazmat_not_permitted', 'feasible_qty', 0);
  END IF;

  -- ground level requirement
  IF COALESCE(v_prof.requires_ground_level,false) AND NOT COALESCE(v_loc.ground_level,false) THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'ground_level_required', 'feasible_qty', 0);
  END IF;

  -- mixing rules
  IF NOT COALESCE(v_loc.allow_mixed_products,true) AND v_occ.distinct_products > 0
     AND NOT EXISTS (SELECT 1 FROM public.stock_quants q
                     WHERE q.location_id = p_location_id AND q.product_id = p_product_id
                       AND COALESCE(q.quantity,0) > 0) THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'single_product_bin_occupied', 'feasible_qty', 0);
  END IF;
  IF NOT COALESCE(v_loc.allow_mixed_lots,true) AND p_lot_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.stock_quants q
                 WHERE q.location_id = p_location_id AND COALESCE(q.quantity,0) > 0
                   AND q.lot_number IS DISTINCT FROM p_lot_number) THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'single_lot_bin_occupied', 'feasible_qty', 0);
  END IF;

  -- unit capacity
  IF v_loc.capacity_max_units IS NOT NULL THEN
    v_cap := v_loc.capacity_max_units - COALESCE(v_occ.units,0);
    v_fit := LEAST(v_fit, GREATEST(v_cap, 0));
  END IF;
  -- weight capacity
  IF v_loc.capacity_max_weight IS NOT NULL AND COALESCE(v_prof.unit_weight,0) > 0 THEN
    v_cap := (v_loc.capacity_max_weight - COALESCE(v_occ.weight,0)) / v_prof.unit_weight;
    v_fit := LEAST(v_fit, GREATEST(v_cap, 0));
  END IF;
  -- volume capacity
  IF v_loc.capacity_max_volume IS NOT NULL AND COALESCE(v_prof.unit_volume,0) > 0 THEN
    v_cap := (v_loc.capacity_max_volume - COALESCE(v_occ.volume,0)) / v_prof.unit_volume;
    v_fit := LEAST(v_fit, GREATEST(v_cap, 0));
  END IF;

  IF v_fit <= 0 THEN
    RETURN jsonb_build_object('feasible', false, 'reason', 'capacity_exceeded', 'feasible_qty', 0);
  END IF;

  RETURN jsonb_build_object(
    'feasible', true,
    'reason', CASE WHEN v_fit < p_quantity THEN 'partial_capacity' ELSE 'ok' END,
    'feasible_qty', v_fit
  );
END $$;

REVOKE ALL ON FUNCTION public.wms_location_feasible(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_location_feasible(uuid, uuid, numeric, text) TO authenticated, service_role;

-- 9) Default strategy seeding
CREATE OR REPLACE FUNCTION public.wms_ensure_default_putaway_strategies(p_warehouse_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wh record; v_n int := 0;
BEGIN
  SELECT id, organization_id, business_id INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RETURN 0; END IF;
  IF EXISTS (SELECT 1 FROM public.wms_putaway_strategies WHERE warehouse_id = p_warehouse_id) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.wms_putaway_strategies
    (organization_id, business_id, warehouse_id, name, strategy_type, sequence)
  VALUES
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Fixed bin',            'fixed_bin',        10),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Cold chain zone',      'cold_chain',       20),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Hazardous zone',       'hazmat_zone',      30),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Heavy item zone',      'heavy_zone',       40),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Consolidate same SKU', 'consolidate',      50),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Expiry (FEFO) zone',   'fefo_zone',        60),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Velocity slotting',    'velocity_slot',    70),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Same category',        'same_category',    80),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Empty bin',            'empty_bin',        90),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Nearest bin',          'nearest',         100),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Bulk storage',         'bulk',            110),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'Overflow',             'overflow',        120),
    (v_wh.organization_id, v_wh.business_id, p_warehouse_id, 'General priority',     'general_priority',130);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.wms_ensure_default_putaway_strategies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_ensure_default_putaway_strategies(uuid) TO authenticated, service_role;

DO $$ DECLARE w record; BEGIN
  FOR w IN SELECT id FROM public.warehouses LOOP
    PERFORM public.wms_ensure_default_putaway_strategies(w.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public._wms_seed_putaway_strategies_on_warehouse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.wms_ensure_default_putaway_strategies(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zz_seed_putaway_strategies ON public.warehouses;
CREATE TRIGGER zz_seed_putaway_strategies AFTER INSERT ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public._wms_seed_putaway_strategies_on_warehouse();
