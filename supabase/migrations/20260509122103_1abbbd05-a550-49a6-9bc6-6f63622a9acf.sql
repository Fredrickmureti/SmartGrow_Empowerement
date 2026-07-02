-- Teach atomic line-item RPCs to preserve per-line project_id / task_id
-- so analytic posting fan-out (project_revenue_entries / project_cost_entries)
-- captures line-level overrides on Edit Bill / Edit PO.

CREATE OR REPLACE FUNCTION public.update_bill_items_atomic(
  _bill_id uuid,
  _items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM bill_items WHERE bill_id = _bill_id;

  INSERT INTO bill_items (
    bill_id, account_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order, project_id, task_id
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
    NULLIF(item->>'task_id','')::uuid
  FROM jsonb_array_elements(_items) AS item;
END;
$$;

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
  DELETE FROM purchase_order_items WHERE purchase_order_id = p_purchase_order_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO purchase_order_items (
      purchase_order_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, received_quantity, sort_order,
      project_id, task_id
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
      COALESCE((item->>'sort_order')::INTEGER, 0),
      NULLIF(item->>'project_id', '')::UUID,
      NULLIF(item->>'task_id', '')::UUID
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN inserted_count;
END;
$$;