
CREATE OR REPLACE FUNCTION public.update_po_items_atomic(
  p_purchase_order_id UUID,
  p_items JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item JSONB;
  inserted_count INTEGER := 0;
BEGIN
  -- Delete existing items
  DELETE FROM purchase_order_items WHERE purchase_order_id = p_purchase_order_id;

  -- Insert new items
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO purchase_order_items (
      purchase_order_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, received_quantity, sort_order
    ) VALUES (
      p_purchase_order_id,
      NULLIF(item->>'product_id', '')::UUID,
      COALESCE(item->>'description', ''),
      COALESCE((item->>'quantity')::NUMERIC, 0),
      COALESCE((item->>'unit_price')::NUMERIC, 0),
      COALESCE((item->>'tax_rate')::NUMERIC, 0),
      COALESCE((item->>'tax_amount')::NUMERIC, 0),
      COALESCE((item->>'line_total')::NUMERIC, 0),
      COALESCE((item->>'received_quantity')::NUMERIC, 0),
      COALESCE((item->>'sort_order')::INTEGER, 0)
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN inserted_count;
END;
$$;
