CREATE OR REPLACE FUNCTION public.resolve_line_base_quantity(p_business_id uuid, p_product_id uuid, p_display_quantity numeric, p_display_uom_id uuid DEFAULT NULL::uuid, p_packaging_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base_uom   uuid;
  v_base_code  text;
  v_pack_qty   numeric;
  v_pack_prod  uuid;
  v_pack_name  text;
  v_base       numeric;
  v_snapshot   text;
BEGIN
  IF p_display_quantity IS NULL THEN
    RAISE EXCEPTION 'resolve_line_base_quantity: display quantity is required' USING ERRCODE = '22023';
  END IF;

  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object(
      'base_quantity', p_display_quantity,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', NULL,
      'base_uom_id', NULL,
      'uom_snapshot', NULL,
      'factor', 1);
  END IF;

  SELECT p.base_uom_id INTO v_base_uom
    FROM public.products p
   WHERE p.id = p_product_id
     AND (p_business_id IS NULL OR p.business_id = p_business_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_line_base_quantity: product % not found in business %',
      p_product_id, p_business_id USING ERRCODE = '22023';
  END IF;

  SELECT u.code INTO v_base_code FROM public.units_of_measure u WHERE u.id = v_base_uom;

  IF p_packaging_id IS NOT NULL THEN
    SELECT pk.qty_in_base_uom, pk.product_id, pk.name
      INTO v_pack_qty, v_pack_prod, v_pack_name
      FROM public.product_packaging pk
     WHERE pk.id = p_packaging_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % not found', p_packaging_id
        USING ERRCODE = '22023';
    END IF;
    IF v_pack_prod IS DISTINCT FROM p_product_id THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % does not belong to product %',
        p_packaging_id, p_product_id USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_pack_qty, 0) <= 0 THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % has no positive qty_in_base_uom',
        p_packaging_id USING ERRCODE = '22023';
    END IF;
    -- Frozen label: "Bag × 50 KG" survives a later rename of the pack.
    v_snapshot := trim(concat_ws(' ', v_pack_name, '×',
                    trim(trailing '.' from trim(trailing '0' from to_char(v_pack_qty, 'FM9999999990.0999'))),
                    v_base_code));
    RETURN jsonb_build_object(
      'base_quantity', p_display_quantity * v_pack_qty,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', p_packaging_id,
      'base_uom_id', v_base_uom,
      'uom_snapshot', v_snapshot,
      'factor', v_pack_qty);
  END IF;

  IF p_display_uom_id IS NOT NULL AND v_base_uom IS NOT NULL
     AND p_display_uom_id <> v_base_uom THEN
    v_base := public.convert_uom(p_display_quantity, p_display_uom_id, v_base_uom);
    SELECT u.code INTO v_snapshot FROM public.units_of_measure u WHERE u.id = p_display_uom_id;
    RETURN jsonb_build_object(
      'base_quantity', v_base,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', NULL,
      'base_uom_id', v_base_uom,
      'uom_snapshot', v_snapshot,
      'factor', CASE WHEN p_display_quantity <> 0 THEN v_base / p_display_quantity ELSE NULL END);
  END IF;

  SELECT u.code INTO v_snapshot
    FROM public.units_of_measure u
   WHERE u.id = COALESCE(p_display_uom_id, v_base_uom);
  RETURN jsonb_build_object(
    'base_quantity', p_display_quantity,
    'display_quantity', p_display_quantity,
    'display_uom_id', COALESCE(p_display_uom_id, v_base_uom),
    'packaging_id', NULL,
    'base_uom_id', v_base_uom,
    'uom_snapshot', v_snapshot,
    'factor', 1);
END
$function$;