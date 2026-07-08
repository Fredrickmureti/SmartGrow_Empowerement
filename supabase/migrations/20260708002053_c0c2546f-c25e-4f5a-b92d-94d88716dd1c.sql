
CREATE OR REPLACE FUNCTION public.apply_physical_count_atomic(
  p_organization_id uuid,
  p_business_id uuid,
  p_warehouse_id uuid,
  p_user_id uuid,
  p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_count_id uuid;
  v_line jsonb;
  v_result jsonb;
BEGIN
  v_count_id := public.physical_count_create(
    p_organization_id, p_business_id, p_warehouse_id, p_user_id, 'full', '{}'::jsonb, NULL, NULL
  );
  PERFORM public.physical_count_freeze(v_count_id, p_user_id);

  -- Apply the explicit counts from the payload
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    PERFORM public.physical_count_record_line(
      v_count_id,
      (v_line->>'product_id')::uuid,
      (v_line->>'counted_qty')::numeric,
      p_user_id, NULL, NULL
    );
  END LOOP;

  -- Any product not in the payload is assumed matched at its system qty
  UPDATE public.physical_count_lines
     SET counted_qty = system_qty_at_freeze,
         counted_by = p_user_id,
         counted_at = now(),
         status = 'matched'
   WHERE count_id = v_count_id
     AND counted_qty IS NULL;

  PERFORM public.physical_count_submit(v_count_id, p_user_id);
  PERFORM public.physical_count_approve(v_count_id, p_user_id, true);
  v_result := public.physical_count_post(v_count_id, p_user_id);

  RETURN v_result || jsonb_build_object('count_id', v_count_id, 'legacy_shim', true);
END $$;
