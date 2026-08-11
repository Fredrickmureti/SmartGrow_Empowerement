CREATE OR REPLACE FUNCTION public.update_po_items_atomic(p_purchase_order_id uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  item JSONB;
  inserted_count INTEGER := 0;
  r public.purchase_orders;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO r FROM public.purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  IF NOT public.user_has_business_access(auth.uid(), r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  IF lower(coalesce(r.status::text, '')) NOT IN ('draft', 'revised', 'rejected') THEN
    RAISE EXCEPTION
      'Purchase order % is %; line items are editable only in draft/revised/rejected. Use revise_purchase_order to reopen it for editing.',
      r.po_number, r.status
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM purchase_order_items WHERE purchase_order_id = p_purchase_order_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO purchase_order_items (
      purchase_order_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, quantity_received, sort_order,
      project_id, task_id,
      packaging_id, display_uom_id, display_quantity
    ) VALUES (
      p_purchase_order_id,
      NULLIF(item->>'product_id', '')::UUID,
      COALESCE(item->>'description', ''),
      COALESCE((item->>'quantity')::NUMERIC, 0),
      COALESCE((item->>'unit_price')::NUMERIC, 0),
      COALESCE((item->>'tax_rate')::NUMERIC, 0),
      COALESCE((item->>'tax_amount')::NUMERIC, 0),
      COALESCE((item->>'line_total')::NUMERIC, 0),
      COALESCE((item->>'quantity_received')::NUMERIC, 0),
      COALESCE((item->>'sort_order')::INTEGER, 0),
      NULLIF(item->>'project_id', '')::UUID,
      NULLIF(item->>'task_id', '')::UUID,
      NULLIF(item->>'packaging_id', '')::UUID,
      NULLIF(item->>'display_uom_id', '')::UUID,
      NULLIF(item->>'display_quantity', '')::NUMERIC
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN inserted_count;
END;
$function$;