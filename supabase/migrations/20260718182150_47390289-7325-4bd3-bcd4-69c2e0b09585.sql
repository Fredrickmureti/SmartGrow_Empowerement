
-- =============================================================
-- Phase 3 · Batch T3 — Unified reservations
-- =============================================================
-- Merge pos_stock_reservations into stock_reservations
-- (source_type='pos', source_id=register_id).
-- The physical table is dropped and re-created as a view so
-- callers (process_pos_transaction, StockTab, RPCs) keep working.

BEGIN;

-- 1. Backfill any live rows into the unified table. -----------
--    Empty in production today (verified), but the guarded
--    INSERT keeps the migration safe if rows appear before
--    the migration lands.
INSERT INTO public.stock_reservations
  (id, organization_id, business_id, branch_id, warehouse_id,
   product_id, quantity, source_type, source_id, reserved_by,
   expires_at, created_at)
SELECT
  r.id, r.organization_id, r.business_id, r.branch_id,
  COALESCE(
    (SELECT s.warehouse_id FROM public.pos_shifts s
      WHERE s.register_id = r.register_id AND s.status = 'open'
      ORDER BY s.opened_at DESC LIMIT 1),
    (SELECT w.id FROM public.warehouses w
      WHERE w.business_id = r.business_id
        AND w.branch_id   = r.branch_id
        AND w.is_active   = true
        AND COALESCE(w.is_in_transit, false) = false
      ORDER BY w.is_default DESC, w.created_at ASC LIMIT 1)
  ),
  r.product_id, r.quantity, 'pos', r.register_id, r.reserved_by,
  r.expires_at, r.created_at
FROM public.pos_stock_reservations r
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_reservations sr
   WHERE sr.source_type = 'pos'
     AND sr.source_id   = r.register_id
     AND sr.product_id  = r.product_id
     AND sr.released_at IS NULL
);

-- 2. Drop the physical table (FKs cascade with it). -----------
DROP TABLE public.pos_stock_reservations CASCADE;

-- 3. Compatibility view. --------------------------------------
--    Exposes the same shape callers used to read.
CREATE VIEW public.pos_stock_reservations
WITH (security_invoker = true) AS
SELECT
  sr.id,
  sr.organization_id,
  sr.business_id,
  sr.branch_id,
  sr.source_id  AS register_id,
  sr.product_id,
  sr.quantity,
  sr.reserved_by,
  sr.expires_at,
  sr.created_at
FROM public.stock_reservations sr
WHERE sr.source_type = 'pos'
  AND sr.released_at IS NULL
  AND (sr.expires_at IS NULL OR sr.expires_at > now());

COMMENT ON VIEW public.pos_stock_reservations IS
  'DEPRECATED compat view over stock_reservations (source_type=''pos''). '
  'ADR 0082 · Batch T3. Do not add new writers — use stock_reservations directly.';

GRANT SELECT ON public.pos_stock_reservations TO authenticated;
GRANT SELECT ON public.pos_stock_reservations TO anon;
GRANT ALL    ON public.pos_stock_reservations TO service_role;

-- 4. INSTEAD OF DELETE trigger. -------------------------------
--    Preserves `DELETE FROM pos_stock_reservations WHERE …`
--    semantics for legacy callers (notably process_pos_transaction).
CREATE OR REPLACE FUNCTION public.tg_pos_stock_reservations_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE id = OLD.id
     AND released_at IS NULL;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER trg_pos_stock_reservations_soft_delete
INSTEAD OF DELETE ON public.pos_stock_reservations
FOR EACH ROW EXECUTE FUNCTION public.tg_pos_stock_reservations_soft_delete();

-- 5. Rewrite reserve_pos_stock to use stock_reservations. -----
CREATE OR REPLACE FUNCTION public.reserve_pos_stock(
  p_organization_id uuid,
  p_product_id uuid,
  p_register_id uuid,
  p_quantity numeric,
  p_reserved_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_available numeric;
  v_register RECORD;
  v_warehouse_id uuid;
BEGIN
  -- Expire stale POS holds first.
  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE source_type = 'pos'
     AND released_at IS NULL
     AND expires_at IS NOT NULL
     AND expires_at <= now();

  SELECT business_id, branch_id, organization_id
    INTO v_register
    FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'register_not_found');
  END IF;
  IF v_register.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'register_belongs_to_different_org');
  END IF;

  -- Resolve the warehouse from the open shift, else the register's
  -- default branch warehouse. Reservation must be branch-consistent.
  SELECT s.warehouse_id INTO v_warehouse_id
    FROM public.pos_shifts s
   WHERE s.register_id = p_register_id AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1;
  IF v_warehouse_id IS NULL THEN
    SELECT w.id INTO v_warehouse_id
      FROM public.warehouses w
     WHERE w.business_id = v_register.business_id
       AND w.branch_id   = v_register.branch_id
       AND w.is_active   = true
       AND COALESCE(w.is_in_transit, false) = false
     ORDER BY w.is_default DESC, w.created_at ASC LIMIT 1;
  END IF;

  v_available := public.get_available_pos_stock(p_product_id, p_register_id);
  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock',
                              'available', v_available);
  END IF;

  -- Collapse prior open POS holds for (register, product) into a single row.
  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE source_type = 'pos'
     AND source_id   = p_register_id
     AND product_id  = p_product_id
     AND released_at IS NULL;

  INSERT INTO public.stock_reservations (
    organization_id, business_id, branch_id, warehouse_id,
    product_id, quantity, source_type, source_id, reserved_by, expires_at
  ) VALUES (
    p_organization_id, v_register.business_id, v_register.branch_id, v_warehouse_id,
    p_product_id, p_quantity, 'pos', p_register_id, p_reserved_by,
    now() + interval '15 minutes'
  );

  RETURN jsonb_build_object('success', true, 'available', v_available);
END;
$fn$;

-- 6. Rewrite release_pos_stock_reservation. -------------------
CREATE OR REPLACE FUNCTION public.release_pos_stock_reservation(
  p_register_id uuid,
  p_product_id  uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE source_type = 'pos'
     AND source_id   = p_register_id
     AND released_at IS NULL
     AND (p_product_id IS NULL OR product_id = p_product_id);
END;
$fn$;

-- 7. Rewrite get_available_pos_stock. -------------------------
CREATE OR REPLACE FUNCTION public.get_available_pos_stock(
  p_product_id uuid,
  p_register_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_branch_id uuid;
  v_business_id uuid;
  v_warehouse_id uuid;
  v_stock numeric;
  v_reserved numeric;
BEGIN
  SELECT pr.branch_id, pr.business_id
    INTO v_branch_id, v_business_id
    FROM public.pos_registers pr WHERE pr.id = p_register_id;
  IF v_branch_id IS NULL OR v_business_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT ps.warehouse_id INTO v_warehouse_id
    FROM public.pos_shifts ps
   WHERE ps.register_id = p_register_id AND ps.status = 'open'
   ORDER BY ps.opened_at DESC LIMIT 1;

  IF v_warehouse_id IS NOT NULL THEN
    SELECT COALESCE(SUM(quantity), 0) INTO v_stock
      FROM public.warehouse_stock
     WHERE product_id = p_product_id
       AND warehouse_id = v_warehouse_id
       AND business_id  = v_business_id
       AND branch_id    = v_branch_id;
  ELSE
    SELECT COALESCE(SUM(ws.quantity), 0) INTO v_stock
      FROM public.warehouse_stock ws
      JOIN public.warehouses w ON w.id = ws.warehouse_id
     WHERE ws.product_id = p_product_id
       AND ws.business_id = v_business_id
       AND ws.branch_id   = v_branch_id
       AND COALESCE(w.is_in_transit, false) = false;
  END IF;

  SELECT COALESCE(SUM(sr.quantity), 0) INTO v_reserved
    FROM public.stock_reservations sr
    JOIN public.pos_registers pr ON pr.id = sr.source_id
   WHERE sr.source_type = 'pos'
     AND sr.released_at IS NULL
     AND (sr.expires_at IS NULL OR sr.expires_at > now())
     AND sr.product_id  = p_product_id
     AND pr.branch_id   = v_branch_id
     AND pr.business_id = v_business_id
     AND sr.source_id  <> p_register_id;

  RETURN GREATEST(0, COALESCE(v_stock, 0) - COALESCE(v_reserved, 0));
END;
$fn$;

-- 8. Rewrite get_available_pos_stock_for_register. ------------
CREATE OR REPLACE FUNCTION public.get_available_pos_stock_for_register(
  p_product_id uuid,
  p_register_id uuid,
  p_exclude_self boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_register RECORD;
  v_warehouse_id uuid;
  v_stock numeric;
  v_reserved numeric;
BEGIN
  SELECT business_id, branch_id INTO v_register
    FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Register % not found', p_register_id;
  END IF;

  SELECT s.warehouse_id INTO v_warehouse_id
    FROM public.pos_shifts s
   WHERE s.register_id = p_register_id AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    SELECT id INTO v_warehouse_id
      FROM public.warehouses
     WHERE business_id = v_register.business_id
       AND branch_id   = v_register.branch_id
       AND is_active   = true
     ORDER BY is_default DESC LIMIT 1;
  END IF;

  IF v_warehouse_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(quantity, 0) INTO v_stock
    FROM public.warehouse_stock
   WHERE warehouse_id = v_warehouse_id AND product_id = p_product_id;

  SELECT COALESCE(SUM(sr.quantity), 0) INTO v_reserved
    FROM public.stock_reservations sr
    JOIN public.pos_registers reg ON reg.id = sr.source_id
   WHERE sr.source_type = 'pos'
     AND sr.released_at IS NULL
     AND (sr.expires_at IS NULL OR sr.expires_at > now())
     AND sr.product_id  = p_product_id
     AND reg.branch_id  = v_register.branch_id
     AND (NOT p_exclude_self OR sr.source_id <> p_register_id);

  RETURN GREATEST(0, COALESCE(v_stock, 0) - COALESCE(v_reserved, 0));
END;
$fn$;

COMMIT;
