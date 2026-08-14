-- =====================================================================
-- ADR 0078 / Phase 4 — costing & valuation guard
-- AVCO (products.cost_price, warehouse_stock.average_cost) is the single
-- valuation authority. cost_layers is lot-level detail, never a second
-- valuation engine. This migration adds: (1) a writer registry, (2) a
-- static coverage check, (3) runtime write-authority guards, (4) a
-- valuation drift report.
-- =====================================================================

-- 1. Registry of authorised valuation writers ------------------------
CREATE TABLE IF NOT EXISTS public.inventory_valuation_writers (
  function_name    text PRIMARY KEY,
  writes_avco      boolean NOT NULL DEFAULT false,
  writes_layers    boolean NOT NULL DEFAULT false,
  role_description text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.inventory_valuation_writers TO authenticated;
GRANT ALL ON public.inventory_valuation_writers TO service_role;

ALTER TABLE public.inventory_valuation_writers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "valuation writers readable by authenticated"
  ON public.inventory_valuation_writers;
CREATE POLICY "valuation writers readable by authenticated"
  ON public.inventory_valuation_writers
  FOR SELECT TO authenticated
  USING (true);

INSERT INTO public.inventory_valuation_writers
  (function_name, writes_avco, writes_layers, role_description)
VALUES
  ('update_weighted_avg_cost_on_receipt', true,  false,
   'Canonical AVCO engine: recomputes products.cost_price and warehouse_stock.average_cost on inbound movements.'),
  ('_maintain_cost_layers',               false, true,
   'Lot-level layer detail: creates layers on inbound and consumes them FIFO on outbound.'),
  ('inventory_apply_cost_revaluation',    false, true,
   'Landed-cost capitalisation onto remaining layers of a goods receipt.'),
  ('inventory_reverse_cost_revaluation',  false, true,
   'Reversal counterpart of inventory_apply_cost_revaluation.'),
  ('landed_cost_selftest',                true,  true,
   'Self-test harness; runs inside a rolled-back transaction only.')
ON CONFLICT (function_name) DO UPDATE
  SET writes_avco = EXCLUDED.writes_avco,
      writes_layers = EXCLUDED.writes_layers,
      role_description = EXCLUDED.role_description;

-- 2. Static coverage check -------------------------------------------
CREATE OR REPLACE FUNCTION public.check_valuation_writer_coverage()
RETURNS TABLE (issue text, function_name text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Routines that mutate valuation state but are not registered.
  SELECT 'unregistered_valuation_writer'::text,
         p.proname::text,
         'writes AVCO or cost layers but is absent from inventory_valuation_writers'::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* '(update\s+(public\.)?warehouse_stock[\s\S]{0,400}average_cost|update\s+(public\.)?products[\s\S]{0,200}cost_price|(insert\s+into|update)\s+(public\.)?cost_layers)'
     AND p.proname NOT IN (SELECT w.function_name FROM public.inventory_valuation_writers w)
     AND p.proname NOT IN ('check_valuation_writer_coverage', 'check_inventory_valuation_drift',
                           'enforce_valuation_write_authority')
  UNION ALL
  -- Registered writers that no longer exist.
  SELECT 'stale_registration'::text,
         w.function_name,
         'registered valuation writer no longer exists in the database'::text
    FROM public.inventory_valuation_writers w
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = w.function_name
         );
$$;

GRANT EXECUTE ON FUNCTION public.check_valuation_writer_coverage() TO authenticated, service_role;

-- 3. Runtime write-authority guard ------------------------------------
-- PostgREST connects as anon/authenticated. Valuation state may only be
-- changed by SECURITY DEFINER costing routines (which run as the table
-- owner), never by a direct API write.
CREATE OR REPLACE FUNCTION public.enforce_valuation_write_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_api_role boolean := current_user IN ('anon', 'authenticated');
BEGIN
  IF TG_TABLE_NAME = 'warehouse_stock' THEN
    IF NEW.average_cost IS DISTINCT FROM OLD.average_cost THEN
      IF v_is_api_role THEN
        RAISE EXCEPTION
          'INVENTORY_VALUATION_WRITE_DENIED: warehouse_stock.average_cost may only be changed by the AVCO engine (ADR 0078)'
          USING ERRCODE = 'P0001';
      END IF;
      IF NEW.average_cost IS NOT NULL AND NEW.average_cost < 0 THEN
        RAISE EXCEPTION 'INVENTORY_NEGATIVE_VALUATION: average_cost cannot be negative'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'cost_layers' THEN
    IF TG_OP = 'INSERT' THEN
      IF v_is_api_role THEN
        RAISE EXCEPTION
          'INVENTORY_VALUATION_WRITE_DENIED: cost_layers is maintained by the costing engine, not by API clients'
          USING ERRCODE = 'P0001';
      END IF;
      IF NEW.unit_cost IS NULL OR NEW.unit_cost < 0 THEN
        RAISE EXCEPTION 'INVENTORY_NEGATIVE_VALUATION: cost_layers.unit_cost must be >= 0'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;

    IF v_is_api_role THEN
      RAISE EXCEPTION
        'INVENTORY_VALUATION_WRITE_DENIED: cost_layers is maintained by the costing engine, not by API clients'
        USING ERRCODE = 'P0001';
    END IF;

    -- Layer history is immutable: only remaining quantity and unit cost
    -- (landed-cost capitalisation) may move.
    IF NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.source_movement_id IS DISTINCT FROM OLD.source_movement_id
       OR NEW.qty_total IS DISTINCT FROM OLD.qty_total
       OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
      RAISE EXCEPTION
        'INVENTORY_LAYER_IMMUTABLE: cost layer provenance (product, business, source movement, qty_total, received_at) cannot be rewritten'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.unit_cost IS NULL OR NEW.unit_cost < 0 THEN
      RAISE EXCEPTION 'INVENTORY_NEGATIVE_VALUATION: cost_layers.unit_cost must be >= 0'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.qty_remaining < 0 OR NEW.qty_remaining > NEW.qty_total THEN
      RAISE EXCEPTION
        'INVENTORY_LAYER_QTY_RANGE: cost layer qty_remaining must stay between 0 and qty_total'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_valuation_authority_ws ON public.warehouse_stock;
CREATE TRIGGER trg_enforce_valuation_authority_ws
  BEFORE UPDATE ON public.warehouse_stock
  FOR EACH ROW EXECUTE FUNCTION public.enforce_valuation_write_authority();

DROP TRIGGER IF EXISTS trg_enforce_valuation_authority_cl ON public.cost_layers;
CREATE TRIGGER trg_enforce_valuation_authority_cl
  BEFORE INSERT OR UPDATE ON public.cost_layers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_valuation_write_authority();

-- 4. Valuation drift report -------------------------------------------
DROP FUNCTION IF EXISTS public.check_inventory_valuation_drift(uuid, numeric);

CREATE OR REPLACE FUNCTION public.check_inventory_valuation_drift(
  _business_id uuid DEFAULT NULL,
  _tolerance numeric DEFAULT 0.01
)
RETURNS TABLE (
  scope           text,
  business_id     uuid,
  warehouse_id    uuid,
  product_id      uuid,
  avco_qty        numeric,
  avco_unit_cost  numeric,
  avco_value      numeric,
  layer_qty       numeric,
  layer_value     numeric,
  value_drift     numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH layers AS (
    SELECT cl.business_id, cl.warehouse_id, cl.product_id,
           SUM(cl.qty_remaining) AS qty,
           SUM(cl.qty_remaining * cl.unit_cost) AS value
      FROM public.cost_layers cl
     WHERE (_business_id IS NULL OR cl.business_id = _business_id)
     GROUP BY 1, 2, 3
  ),
  wh AS (
    SELECT ws.business_id, ws.warehouse_id, ws.product_id,
           COALESCE(ws.quantity, 0) AS qty,
           COALESCE(ws.average_cost, 0) AS unit_cost,
           ROUND(COALESCE(ws.quantity, 0) * COALESCE(ws.average_cost, 0), 2) AS value
      FROM public.warehouse_stock ws
     WHERE (_business_id IS NULL OR ws.business_id = _business_id)
  )
  SELECT 'warehouse_avco_vs_layers'::text,
         wh.business_id, wh.warehouse_id, wh.product_id,
         wh.qty, wh.unit_cost, wh.value,
         COALESCE(l.qty, 0), ROUND(COALESCE(l.value, 0), 2),
         ROUND(wh.value - COALESCE(l.value, 0), 2)
    FROM wh
    LEFT JOIN layers l
      ON l.business_id = wh.business_id
     AND l.product_id = wh.product_id
     AND l.warehouse_id IS NOT DISTINCT FROM wh.warehouse_id
   WHERE ABS(wh.value - ROUND(COALESCE(l.value, 0), 2)) > _tolerance

  UNION ALL

  SELECT 'product_avco_vs_layers'::text,
         p.business_id, NULL::uuid, p.id,
         COALESCE(p.stock_quantity, 0),
         COALESCE(p.cost_price, 0),
         ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0), 2),
         COALESCE(pl.qty, 0), ROUND(COALESCE(pl.value, 0), 2),
         ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0)
               - COALESCE(pl.value, 0), 2)
    FROM public.products p
    LEFT JOIN (
      SELECT business_id, product_id, SUM(qty) AS qty, SUM(value) AS value
        FROM layers GROUP BY 1, 2
    ) pl ON pl.business_id = p.business_id AND pl.product_id = p.id
   WHERE (_business_id IS NULL OR p.business_id = _business_id)
     AND ABS(ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0), 2)
             - ROUND(COALESCE(pl.value, 0), 2)) > _tolerance;
$$;

GRANT EXECUTE ON FUNCTION public.check_inventory_valuation_drift(uuid, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.check_inventory_valuation_drift(uuid, numeric) IS
  'ADR 0078 Phase 4: reports disagreement between AVCO valuation (warehouse_stock/products) and the cost_layers roll-up. Empty result = valuation views agree.';