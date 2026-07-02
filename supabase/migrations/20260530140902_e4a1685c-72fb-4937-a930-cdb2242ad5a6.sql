-- Phase 5.1 (b): wire compute_unit_cost into process_pos_transaction COGS.
-- Caller-supplied cost still wins when positive; helper only fills the gap.
DO $migrate$
DECLARE
  v_src text;
  v_old text := 'v_item_unit_cost := COALESCE((v_item->>''cost_price'')::numeric, 0);';
  v_new text := 'v_item_unit_cost := COALESCE(NULLIF((v_item->>''cost_price'')::numeric, 0), public.compute_unit_cost(v_register_business_id, NULLIF(v_item->>''product_id'','''')::uuid, v_default_warehouse_id), 0);';
BEGIN
  v_src := pg_get_functiondef('public.process_pos_transaction(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,numeric,numeric,numeric,text,uuid,text,text,text,uuid,uuid,uuid,numeric,uuid,text)'::regprocedure);
  IF position(v_old in v_src) = 0 THEN
    RAISE EXCEPTION 'Phase 5.1b: expected COGS assignment not found in process_pos_transaction';
  END IF;
  v_src := replace(v_src, v_old, v_new);
  EXECUTE v_src;
END $migrate$;