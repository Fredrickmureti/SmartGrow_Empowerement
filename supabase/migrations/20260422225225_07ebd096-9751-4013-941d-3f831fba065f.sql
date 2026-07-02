-- =====================================================================
-- Phase C: Tighten warehouse ↔ branch coupling
--
-- 1. Backfill any NULL warehouses.branch_id to that company's HQ branch.
-- 2. Make warehouses.branch_id NOT NULL going forward.
-- 3. Keep warehouse_stock.branch_id in sync with its warehouse (trigger).
-- 4. Forbid reassigning a warehouse's company OR branch once any
--    stock_movements exist for it (Odoo-style immutability — branch
--    history would otherwise be silently rewritten).
-- =====================================================================

-- 1. Backfill NULL warehouses.branch_id from each warehouse's company HQ branch.
--    `branches.is_headquarters` is enforced unique-per-business, so this is safe.
UPDATE public.warehouses w
SET branch_id = b.id
FROM public.branches b
WHERE w.branch_id IS NULL
  AND w.business_id IS NOT NULL
  AND b.business_id = w.business_id
  AND b.is_headquarters = TRUE;

-- For warehouses with NULL business_id too (legacy rows), assign both:
-- pick the org's first business + its HQ branch.
UPDATE public.warehouses w
SET business_id = sub.business_id,
    branch_id   = sub.branch_id
FROM (
  SELECT DISTINCT ON (w2.id)
    w2.id            AS warehouse_id,
    b.business_id    AS business_id,
    b.id             AS branch_id
  FROM public.warehouses w2
  JOIN public.businesses biz ON biz.organization_id = w2.organization_id
  JOIN public.branches  b   ON b.business_id = biz.id AND b.is_headquarters = TRUE
  WHERE w2.branch_id IS NULL
  ORDER BY w2.id, biz.created_at ASC
) sub
WHERE w.id = sub.warehouse_id;

-- Safety check: after backfill, no NULL branch_id should remain.
DO $$
DECLARE
  n_null_branch INT;
BEGIN
  SELECT COUNT(*) INTO n_null_branch FROM public.warehouses WHERE branch_id IS NULL;
  IF n_null_branch > 0 THEN
    RAISE EXCEPTION 'Cannot enforce NOT NULL: % warehouse(s) still have NULL branch_id (likely org has no HQ branch). Fix manually then re-run.', n_null_branch;
  END IF;
END $$;

-- 2. Tighten the column.
ALTER TABLE public.warehouses
  ALTER COLUMN branch_id SET NOT NULL;

-- 3. Sync trigger: when a warehouse's branch_id changes, propagate to
--    every warehouse_stock row for that warehouse. (We also forbid the
--    change in step 4 once movements exist; this trigger handles the
--    "no movements yet" early-config case.)
CREATE OR REPLACE FUNCTION public.sync_warehouse_stock_branch_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    UPDATE public.warehouse_stock
    SET branch_id   = NEW.branch_id,
        business_id = NEW.business_id
    WHERE warehouse_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_warehouse_stock_branch_id ON public.warehouses;
CREATE TRIGGER trg_sync_warehouse_stock_branch_id
AFTER UPDATE OF branch_id, business_id ON public.warehouses
FOR EACH ROW
EXECUTE FUNCTION public.sync_warehouse_stock_branch_id();

-- 4. Immutability guard: once stock_movements exist for a warehouse,
--    its (business_id, branch_id) cannot change. This prevents silent
--    rewriting of historical branch attribution and matches Odoo's
--    treatment of warehouses as locked once they have move history.
CREATE OR REPLACE FUNCTION public.warehouse_lock_scope_after_movements()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  has_movements BOOLEAN;
BEGIN
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.branch_id  IS DISTINCT FROM OLD.branch_id THEN
    SELECT EXISTS (
      SELECT 1 FROM public.stock_movements WHERE warehouse_id = OLD.id
    ) INTO has_movements;

    IF has_movements THEN
      RAISE EXCEPTION
        'Cannot reassign warehouse % (% → %) to a different company/branch: stock movements already exist. Create a new warehouse instead.',
        OLD.id,
        OLD.branch_id, NEW.branch_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warehouse_lock_scope ON public.warehouses;
CREATE TRIGGER trg_warehouse_lock_scope
BEFORE UPDATE OF business_id, branch_id ON public.warehouses
FOR EACH ROW
EXECUTE FUNCTION public.warehouse_lock_scope_after_movements();

COMMENT ON FUNCTION public.sync_warehouse_stock_branch_id() IS
  'Phase C: propagate warehouse.branch_id/business_id changes to warehouse_stock. Combined with warehouse_lock_scope_after_movements, only safe (no movements yet) reassignments succeed.';
COMMENT ON FUNCTION public.warehouse_lock_scope_after_movements() IS
  'Phase C: forbid changing a warehouse''s company or branch once any stock_movements exist, to keep historical branch attribution trustworthy.';