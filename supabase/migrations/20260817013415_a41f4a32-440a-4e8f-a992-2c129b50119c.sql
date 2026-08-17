-- INV-SIM Repair #7: the allow_negative exemption only matched movement_type
-- 'adjustment'. Lot-aware adjustment postings write 'adjustment_out' /
-- 'adjustment_in' (consume_lots_atomic), so an explicitly allow_negative
-- adjustment was still rejected. Cover the lot-aware variants.
CREATE OR REPLACE FUNCTION public.validate_stock_movement_quantity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_available_qty numeric;
  v_allow_negative boolean := false;
  v_adj_id uuid;
BEGIN
  IF NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.movement_type IN ('count', 'migration') THEN
    RETURN NEW;
  END IF;

  -- A physical count reconciles to physical reality and is authoritative:
  -- posting a shortage must succeed even below zero on-hand.
  IF NEW.reference_type = 'physical_count' THEN
    RETURN NEW;
  END IF;

  IF NEW.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'stock_movements.warehouse_id is required (movement_type=%)', NEW.movement_type;
  END IF;

  IF NEW.movement_type IN ('adjustment', 'adjustment_out', 'adjustment_in')
     AND NEW.reference_type = 'stock_adjustment' THEN
    v_adj_id := NEW.reference_id;
    IF v_adj_id IS NOT NULL THEN
      SELECT COALESCE(allow_negative, false) INTO v_allow_negative
        FROM public.stock_adjustments WHERE id = v_adj_id;
      IF COALESCE(v_allow_negative, false) THEN
        RETURN NEW;
      END IF;
    END IF;
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
$function$;

-- INV-SIM Repair #8: physical_count_post was self-blocking. The count's own
-- freeze reservations were only released by the AFTER UPDATE trigger, i.e.
-- after the adjustment movements had already been written and validated
-- against (quantity - reserved_quantity) = 0. Release the count's own
-- reservations first; the post-state trigger then releases nothing further.
CREATE OR REPLACE FUNCTION public.physical_count_release_freeze_before_post(p_count_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$ SELECT public._release_physical_count_reservations(p_count_id) $$;

REVOKE ALL ON FUNCTION public.physical_count_release_freeze_before_post(uuid) FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'physical_count_post';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'physical_count_post missing';
  END IF;

  IF position('physical_count_release_freeze_before_post' IN v_src) = 0 THEN
    v_src := replace(
      v_src,
      '    v_approve_result := public.approve_stock_adjustment_atomic(v_adj_id, p_user_id);',
      '    -- Repair #8: lift this count''s own freeze before writing movements.'
      || E'\n    PERFORM public.physical_count_release_freeze_before_post(p_count_id);'
      || E'\n\n    v_approve_result := public.approve_stock_adjustment_atomic(v_adj_id, p_user_id);'
    );
    IF position('physical_count_release_freeze_before_post' IN v_src) = 0 THEN
      RAISE EXCEPTION 'Repair #8: could not locate approve_stock_adjustment_atomic call site';
    END IF;
    EXECUTE v_src;
  END IF;
END $do$;