-- Phase 5.1 (a): wire compute_unit_cost into complete_delivery_atomic COGS path.
-- Surgical: only replaces the single v_unit_cost assignment; rest of the
-- function body is preserved byte-for-byte via pg_get_functiondef.
DO $migrate$
DECLARE
  v_src text;
  v_old text := 'v_unit_cost := COALESCE(v_item.cost_price, 0);';
  v_new text := 'v_unit_cost := COALESCE(NULLIF(public.compute_unit_cost(v_biz_id, v_item.product_id, v_warehouse_id), 0), v_item.cost_price, 0);';
BEGIN
  v_src := pg_get_functiondef('public.complete_delivery_atomic(uuid,uuid,text,jsonb,uuid)'::regprocedure);
  IF position(v_old in v_src) = 0 THEN
    RAISE EXCEPTION 'Phase 5.1a: expected COGS assignment not found in complete_delivery_atomic';
  END IF;
  v_src := replace(v_src, v_old, v_new);
  EXECUTE v_src;
END $migrate$;