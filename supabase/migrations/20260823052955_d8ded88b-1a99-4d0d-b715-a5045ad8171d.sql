CREATE OR REPLACE FUNCTION public.update_bill_items_atomic(_bill_id uuid, _items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM bill_items WHERE bill_id = _bill_id;

  INSERT INTO bill_items (
    bill_id, account_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order, project_id, task_id,
    analytic_account_id
  )
  SELECT
    _bill_id,
    NULLIF(item->>'account_id','')::uuid,
    NULLIF(item->>'product_id','')::uuid,
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    COALESCE((item->>'tax_rate')::numeric, 0),
    COALESCE((item->>'tax_amount')::numeric, 0),
    (item->>'line_total')::numeric,
    (item->>'sort_order')::int,
    NULLIF(item->>'project_id','')::uuid,
    NULLIF(item->>'task_id','')::uuid,
    NULLIF(item->>'analytic_account_id','')::uuid
  FROM jsonb_array_elements(_items) AS item;
END;
$function$;