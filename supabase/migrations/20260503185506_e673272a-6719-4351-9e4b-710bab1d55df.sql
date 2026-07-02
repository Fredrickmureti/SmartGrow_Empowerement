-- Phase I — Inventory branch-isolation data repair + going-forward guards.
-- Idempotent: each step is conditional and safe to re-run.

DO $$
DECLARE
  v_fixed_wh INT := 0;
  v_fixed_ws INT := 0;
  v_fixed_sm INT := 0;
  v_fixed_pq INT := 0;
BEGIN
  -- 1. Backfill warehouses.branch_id for non-transit warehouses where NULL,
  --    using the business's primary (first-created) branch.
  WITH primary_branch AS (
    SELECT DISTINCT ON (business_id) business_id, id AS branch_id
    FROM public.branches
    WHERE COALESCE(is_active, true) = true
    ORDER BY business_id, created_at ASC
  )
  UPDATE public.warehouses w
  SET branch_id = pb.branch_id
  FROM primary_branch pb
  WHERE w.branch_id IS NULL
    AND COALESCE(w.is_in_transit, false) = false
    AND w.business_id = pb.business_id;
  GET DIAGNOSTICS v_fixed_wh = ROW_COUNT;
  RAISE NOTICE 'Phase I: backfilled branch_id on % warehouse(s)', v_fixed_wh;

  -- 2. Recompute warehouse_stock.branch_id from parent warehouse where they
  --    disagree or are NULL.
  UPDATE public.warehouse_stock ws
  SET branch_id = w.branch_id
  FROM public.warehouses w
  WHERE ws.warehouse_id = w.id
    AND w.branch_id IS NOT NULL
    AND (ws.branch_id IS DISTINCT FROM w.branch_id);
  GET DIAGNOSTICS v_fixed_ws = ROW_COUNT;
  RAISE NOTICE 'Phase I: realigned branch_id on % warehouse_stock row(s)', v_fixed_ws;

  -- 3. Recompute stock_movements.branch_id similarly (skip in-transit/null wh).
  UPDATE public.stock_movements sm
  SET branch_id = w.branch_id
  FROM public.warehouses w
  WHERE sm.warehouse_id = w.id
    AND w.branch_id IS NOT NULL
    AND (sm.branch_id IS DISTINCT FROM w.branch_id);
  GET DIAGNOSTICS v_fixed_sm = ROW_COUNT;
  RAISE NOTICE 'Phase I: realigned branch_id on % stock_movement row(s)', v_fixed_sm;

  -- 4. Reconcile products.stock_quantity (the cached company-wide aggregate)
  --    to match SUM(warehouse_stock.quantity).
  WITH totals AS (
    SELECT product_id, SUM(quantity)::numeric AS total_qty
    FROM public.warehouse_stock
    GROUP BY product_id
  )
  UPDATE public.products p
  SET stock_quantity = COALESCE(t.total_qty, 0)
  FROM totals t
  WHERE p.id = t.product_id
    AND COALESCE(p.stock_quantity, 0) IS DISTINCT FROM COALESCE(t.total_qty, 0);
  GET DIAGNOSTICS v_fixed_pq = ROW_COUNT;
  RAISE NOTICE 'Phase I: reconciled products.stock_quantity for % product(s)', v_fixed_pq;
END $$;

-- 5. Going-forward guard: every non-transit warehouse must have a branch.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_branch_required'
  ) THEN
    ALTER TABLE public.warehouses
      ADD CONSTRAINT warehouses_branch_required
      CHECK (COALESCE(is_in_transit, false) OR branch_id IS NOT NULL) NOT VALID;
    -- Validate now that backfill is complete.
    BEGIN
      ALTER TABLE public.warehouses VALIDATE CONSTRAINT warehouses_branch_required;
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'warehouses_branch_required validation deferred — non-transit warehouses still missing branch_id';
    END;
  END IF;
END $$;

-- 6. Trigger to keep warehouse_stock.branch_id consistent with the parent
--    warehouse on insert/update. This is the second line of defense
--    behind the architecture tests.
CREATE OR REPLACE FUNCTION public.enforce_warehouse_stock_branch_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wh_branch UUID;
  v_wh_business UUID;
  v_wh_org UUID;
  v_in_transit BOOLEAN;
BEGIN
  SELECT branch_id, business_id, organization_id, COALESCE(is_in_transit, false)
  INTO v_wh_branch, v_wh_business, v_wh_org, v_in_transit
  FROM public.warehouses
  WHERE id = NEW.warehouse_id;

  IF v_wh_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_stock.warehouse_id % not found', NEW.warehouse_id;
  END IF;

  -- For non-transit warehouses, force branch_id to match parent.
  IF NOT v_in_transit THEN
    IF v_wh_branch IS NULL THEN
      RAISE EXCEPTION 'Parent warehouse % is missing branch_id; refuse to write stock', NEW.warehouse_id;
    END IF;
    NEW.branch_id := v_wh_branch;
  END IF;

  -- Force tenant scope columns to match parent — defense against bad client writes.
  NEW.organization_id := v_wh_org;
  IF v_wh_business IS NOT NULL THEN
    NEW.business_id := v_wh_business;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_warehouse_stock_branch_consistency ON public.warehouse_stock;
CREATE TRIGGER trg_warehouse_stock_branch_consistency
BEFORE INSERT OR UPDATE OF warehouse_id, branch_id, organization_id, business_id
ON public.warehouse_stock
FOR EACH ROW
EXECUTE FUNCTION public.enforce_warehouse_stock_branch_consistency();
