-- Backward-compatible shim for stale cached clients hitting
-- /rpc/create_product_with_opening_stock_atomic with legacy named keys.
--
-- Why: PostgREST resolves RPCs by parameter names for named-argument calls.
-- If a browser is still running an older cached bundle, it can send the old
-- key set and receive a 404 even though the current 3-arg function exists.
--
-- Strategy: add a single-jsonb overload so PostgREST can fall back to it when
-- named-argument resolution misses. The shim normalizes both legacy and current
-- payload shapes, then delegates to the canonical 3-arg function.

CREATE OR REPLACE FUNCTION public.create_product_with_opening_stock_atomic(jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  p_body alias for $1;
  v_product jsonb;
  v_opening_items jsonb;
  v_user_id uuid;
BEGIN
  IF p_body IS NULL OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Request body must be a JSON object';
  END IF;

  -- Current shape
  v_product := p_body->'p_product';
  v_opening_items := p_body->'p_opening_items';
  v_user_id := NULLIF(p_body->>'p_user_id', '')::uuid;

  -- Legacy fallback shape used by stale cached clients
  IF v_product IS NULL THEN
    v_product := p_body->'p_product_data';
  END IF;

  IF v_opening_items IS NULL THEN
    v_opening_items := COALESCE(p_body->'p_opening_lines', p_body->'p_opening_items');
  END IF;

  IF v_user_id IS NULL THEN
    v_user_id := NULLIF(COALESCE(p_body->>'p_current_user_id', p_body->>'p_user_id'), '')::uuid;
  END IF;

  IF v_product IS NULL THEN
    RAISE EXCEPTION 'Missing product payload';
  END IF;

  RETURN public.create_product_with_opening_stock_atomic(
    v_product,
    COALESCE(v_opening_items, '[]'::jsonb),
    v_user_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_product_with_opening_stock_atomic(jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.create_product_with_opening_stock_atomic(jsonb) TO authenticated;

COMMENT ON FUNCTION public.create_product_with_opening_stock_atomic(jsonb)
IS 'Compatibility shim for stale cached clients: accepts both current and legacy JSON RPC key names, then delegates to the canonical 3-arg create_product_with_opening_stock_atomic function.';