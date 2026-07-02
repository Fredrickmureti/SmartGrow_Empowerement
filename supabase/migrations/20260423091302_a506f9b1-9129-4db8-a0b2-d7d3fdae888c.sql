-- ============================================================
-- Stage B — Inventory schema lock-down
-- Phase G audit corrections
-- ============================================================

-- ------------------------------------------------------------
-- B.1  stock_movements.warehouse_id → NOT NULL
-- ------------------------------------------------------------
-- Backfill any historical rows from the warehouse on the
-- referenced source document; otherwise from any existing
-- per-product warehouse_stock row.  This is defensive only;
-- the architecture test already prevents new app paths from
-- inserting without a warehouse_id.
UPDATE public.stock_movements sm
   SET warehouse_id = ws.warehouse_id
  FROM public.warehouse_stock ws
 WHERE sm.warehouse_id IS NULL
   AND ws.product_id = sm.product_id
   AND ws.business_id = sm.business_id
   AND (ws.branch_id = sm.branch_id OR sm.branch_id IS NULL);

-- Anything still NULL cannot be safely scoped — there should be
-- zero in production. Refuse to proceed silently if any remain.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.stock_movements WHERE warehouse_id IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Stage B: % stock_movements rows still have NULL warehouse_id; cannot enforce NOT NULL.', v_n;
  END IF;
END $$;

ALTER TABLE public.stock_movements
  ALTER COLUMN warehouse_id SET NOT NULL;

-- ------------------------------------------------------------
-- B.2  validate_stock_movement_quantity — drop dead branch
-- The "warehouse_id IS NULL" arm read products.stock_quantity
-- (a company-wide aggregate) which combined with the writeable
-- column was a foot-gun. With B.1 the arm is now also unreachable;
-- replace it with an explicit hard-fail so future RPCs cannot
-- bypass per-warehouse validation by omitting warehouse_id.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_stock_movement_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available_qty numeric;
BEGIN
  IF NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.movement_type IN ('count', 'adjustment', 'migration') THEN
    RETURN NEW;
  END IF;

  IF NEW.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'stock_movements.warehouse_id is required (movement_type=%)', NEW.movement_type;
  END IF;

  SELECT COALESCE(ws.quantity, 0) - COALESCE(ws.reserved_quantity, 0)
    INTO v_available_qty
    FROM warehouse_stock ws
   WHERE ws.warehouse_id = NEW.warehouse_id
     AND ws.product_id = NEW.product_id;

  IF v_available_qty IS NULL THEN
    v_available_qty := 0;
  END IF;

  IF (v_available_qty + NEW.quantity) < 0 THEN
    RAISE EXCEPTION 'Insufficient stock in warehouse. Available: %, Requested: %',
      v_available_qty, ABS(NEW.quantity);
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- B.3  Lock products.stock_quantity to trigger-only writes.
--
-- products.stock_quantity is a *cached aggregate* of
-- warehouse_stock maintained by update_product_stock(). Any
-- direct UPDATE from the app desyncs the aggregate forever
-- because update_product_stock keeps incrementing from the
-- corrupted base.
--
-- Strategy: BEFORE UPDATE trigger that rejects mutation of
-- stock_quantity unless it is being written from inside another
-- trigger (pg_trigger_depth() > 0). update_product_stock runs
-- as a trigger so its updates pass; direct app UPDATEs do not.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_products_stock_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity
     AND pg_trigger_depth() < 2 THEN
    -- depth 1 = this trigger itself; depth 2+ = called from another
    -- trigger (e.g. update_product_stock). Reject direct app writes.
    RAISE EXCEPTION 'products.stock_quantity is a derived aggregate of warehouse_stock and cannot be written directly. Use a stock_adjustment (opening / count / adjustment) against a specific warehouse.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_products_stock_quantity ON public.products;
CREATE TRIGGER trg_guard_products_stock_quantity
  BEFORE UPDATE OF stock_quantity ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_products_stock_quantity();

-- Also reject direct INSERT with a non-zero stock_quantity from the app.
-- Trigger-driven inserts (none currently, but defensive) at depth >=1 pass.
CREATE OR REPLACE FUNCTION public.guard_products_stock_quantity_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.stock_quantity, 0) <> 0 AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'products.stock_quantity must be 0 on INSERT. Record opening stock via a stock_adjustment against a specific warehouse.';
  END IF;
  -- Force to 0 in case the app passed NULL or 0 with extra noise.
  NEW.stock_quantity := COALESCE(NEW.stock_quantity, 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_products_stock_quantity_insert ON public.products;
CREATE TRIGGER trg_guard_products_stock_quantity_insert
  BEFORE INSERT ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_products_stock_quantity_insert();

-- ------------------------------------------------------------
-- B.4  Branch provisioning must fail loudly, not log & continue.
-- Removes the swallowed exception so a branch can never be
-- created without its default warehouse.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_default_inventory_for_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_user_id uuid;
  v_wh_code text;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  v_wh_code := 'WH-' || COALESCE(NULLIF(NEW.code, ''), substr(NEW.id::text, 1, 8));

  -- No EXCEPTION block: if warehouse seeding fails the whole branch
  -- INSERT must roll back so the operator sees the error immediately
  -- rather than discovering an inventory-blind branch at first sale.
  INSERT INTO public.warehouses (
    organization_id, business_id, branch_id, code, name,
    is_default, is_active, is_in_transit
  )
  SELECT NEW.organization_id, NEW.business_id, NEW.id,
         v_wh_code,
         COALESCE(NEW.name, 'Branch') || ' Warehouse',
         true, true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM public.warehouses w
     WHERE w.branch_id = NEW.id
       AND w.is_in_transit = false
  );

  -- Owner gets immediate access to the new branch.
  SELECT owner_user_id INTO v_owner_user_id
    FROM public.organizations
   WHERE id = NEW.organization_id;

  IF v_owner_user_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.user_branch_assignments (
        user_id, organization_id, business_id, branch_id,
        is_primary, can_view, can_manage, assigned_by
      ) VALUES (
        v_owner_user_id, NEW.organization_id, NEW.business_id, NEW.id,
        NEW.is_headquarters, true, true, v_owner_user_id
      )
      ON CONFLICT (user_id, branch_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      -- Owner-assignment failure is recoverable (admin can re-add); do
      -- not fail the branch INSERT for this.
      RAISE NOTICE 'Owner branch assignment failed for branch %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;