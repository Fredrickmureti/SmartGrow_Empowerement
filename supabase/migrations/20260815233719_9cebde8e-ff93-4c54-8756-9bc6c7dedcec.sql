-- 1. One place that resolves a register's selling scope.
CREATE OR REPLACE FUNCTION public.pos_register_stock_scope(p_register_id uuid)
RETURNS TABLE(business_id uuid, branch_id uuid, warehouse_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_register RECORD;
  v_warehouse_id uuid;
BEGIN
  SELECT r.business_id, r.branch_id INTO v_register
    FROM public.pos_registers r WHERE r.id = p_register_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Register % not found', p_register_id;
  END IF;

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
     ORDER BY w.is_default DESC LIMIT 1;
  END IF;

  business_id  := v_register.business_id;
  branch_id    := v_register.branch_id;
  warehouse_id := v_warehouse_id;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_register_stock_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_register_stock_scope(uuid) TO authenticated, service_role;

-- 2. Single-product wrapper now delegates scope resolution to the helper.
CREATE OR REPLACE FUNCTION public.get_available_pos_stock_for_register(p_product_id uuid, p_register_id uuid, p_exclude_self boolean DEFAULT true)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scope RECORD;
  v numeric;
BEGIN
  -- ADR 0142: thin wrapper. Do not reimplement availability here.
  SELECT * INTO v_scope FROM public.pos_register_stock_scope(p_register_id);
  IF v_scope.warehouse_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT a.available INTO v
    FROM public.resolve_stock_availability(
           p_product_id,
           v_scope.business_id,
           v_scope.branch_id,
           v_scope.warehouse_id,
           CASE WHEN p_exclude_self THEN 'pos' ELSE NULL END,
           CASE WHEN p_exclude_self THEN p_register_id ELSE NULL END
         ) a;

  RETURN GREATEST(0, COALESCE(v, 0));
END;
$function$;

-- 3. Batch wrapper: one round trip per cart, same authority.
CREATE OR REPLACE FUNCTION public.get_available_pos_stock_for_register_batch(
  p_product_ids uuid[],
  p_register_id uuid,
  p_exclude_self boolean DEFAULT true
)
RETURNS TABLE(product_id uuid, available numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scope RECORD;
BEGIN
  IF p_product_ids IS NULL OR array_length(p_product_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_scope FROM public.pos_register_stock_scope(p_register_id);

  IF v_scope.warehouse_id IS NULL THEN
    RETURN QUERY
      SELECT DISTINCT u, 0::numeric FROM unnest(p_product_ids) AS u WHERE u IS NOT NULL;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT b.product_id, GREATEST(0, COALESCE(b.available, 0))
    FROM public.resolve_stock_availability_batch(
           p_product_ids,
           v_scope.business_id,
           v_scope.branch_id,
           v_scope.warehouse_id,
           CASE WHEN p_exclude_self THEN 'pos' ELSE NULL END,
           CASE WHEN p_exclude_self THEN p_register_id ELSE NULL END,
           NULL::uuid[]
         ) b;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_available_pos_stock_for_register_batch(uuid[], uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_available_pos_stock_for_register_batch(uuid[], uuid, boolean) TO authenticated, service_role;

-- 4. Branch-true realtime signal for the till.
ALTER TABLE public.stock_quants REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'stock_quants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_quants;
  END IF;
END$$;