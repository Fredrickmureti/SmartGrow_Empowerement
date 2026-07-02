
-- Fix transfer_table_items: recalculate tax_amount and line_total proportionally for split quantities
CREATE OR REPLACE FUNCTION public.transfer_table_items(
  p_organization_id uuid,
  p_source_session_id uuid,
  p_target_session_id uuid,
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer_id uuid;
  v_target_txn_id uuid;
  v_source_txn_id uuid;
  v_item_spec jsonb;
  v_current_item record;
  v_moved_count int := 0;
  v_transfer_qty int;
  v_original_qty int;
  v_new_tax_amount numeric;
  v_new_line_total numeric;
  v_remaining_tax numeric;
  v_remaining_total numeric;
BEGIN
  -- Get source transaction (for totals recalc)
  SELECT id INTO v_source_txn_id
  FROM pos_transactions
  WHERE table_session_id = p_source_session_id
    AND status = 'pending'
    AND organization_id = p_organization_id
  LIMIT 1
  FOR UPDATE;

  -- Get target pending transaction
  SELECT id INTO v_target_txn_id
  FROM pos_transactions
  WHERE table_session_id = p_target_session_id
    AND status = 'pending'
    AND organization_id = p_organization_id
  LIMIT 1
  FOR UPDATE;

  IF v_target_txn_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Target table has no active order');
  END IF;

  -- Create audit record
  INSERT INTO pos_table_transfers (organization_id, transfer_type, source_session_id, target_session_id, notes, created_by)
  VALUES (p_organization_id, 'transfer_items', p_source_session_id, p_target_session_id, p_notes, p_user_id)
  RETURNING id INTO v_transfer_id;

  -- Process each item
  FOR v_item_spec IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_current_item
    FROM pos_transaction_items
    WHERE id = (v_item_spec->>'transaction_item_id')::uuid
    FOR UPDATE;

    IF v_current_item IS NULL THEN
      RAISE EXCEPTION 'Item % not found', v_item_spec->>'transaction_item_id';
    END IF;

    v_transfer_qty := (v_item_spec->>'quantity')::int;
    v_original_qty := v_current_item.quantity;

    IF v_transfer_qty >= v_original_qty THEN
      -- Move entire item (no recalculation needed)
      UPDATE pos_transaction_items SET transaction_id = v_target_txn_id WHERE id = v_current_item.id;
    ELSE
      -- Split: calculate proportional amounts
      v_new_tax_amount := ROUND((COALESCE(v_current_item.tax_amount, 0) * v_transfer_qty::numeric / v_original_qty::numeric), 2);
      v_new_line_total := ROUND((v_current_item.line_total * v_transfer_qty::numeric / v_original_qty::numeric), 2);
      v_remaining_tax := COALESCE(v_current_item.tax_amount, 0) - v_new_tax_amount;
      v_remaining_total := v_current_item.line_total - v_new_line_total;

      -- Update source item with reduced quantity AND recalculated amounts
      UPDATE pos_transaction_items
      SET quantity = v_original_qty - v_transfer_qty,
          tax_amount = v_remaining_tax,
          line_total = v_remaining_total
      WHERE id = v_current_item.id;

      -- Create new item on target with proportional amounts
      INSERT INTO pos_transaction_items (
        transaction_id, product_id, description, quantity, unit_price,
        discount_type, discount_value, tax_rate, tax_amount, line_total,
        cost_price, sort_order, tax_rate_id, etims_tax_code
      ) VALUES (
        v_target_txn_id, v_current_item.product_id, v_current_item.description,
        v_transfer_qty, v_current_item.unit_price,
        v_current_item.discount_type, v_current_item.discount_value,
        v_current_item.tax_rate, v_new_tax_amount, v_new_line_total,
        v_current_item.cost_price, v_current_item.sort_order,
        v_current_item.tax_rate_id, v_current_item.etims_tax_code
      );
    END IF;

    INSERT INTO pos_transfer_items (transfer_id, transaction_item_id, quantity)
    VALUES (v_transfer_id, v_current_item.id, v_transfer_qty);

    v_moved_count := v_moved_count + 1;
  END LOOP;

  -- Recalculate both transaction totals
  UPDATE pos_transactions
  SET subtotal = COALESCE((SELECT SUM(line_total - COALESCE(tax_amount, 0)) FROM pos_transaction_items WHERE transaction_id = v_source_txn_id), 0),
      tax_amount = COALESCE((SELECT SUM(COALESCE(tax_amount, 0)) FROM pos_transaction_items WHERE transaction_id = v_source_txn_id), 0),
      total = COALESCE((SELECT SUM(line_total) FROM pos_transaction_items WHERE transaction_id = v_source_txn_id), 0),
      version = version + 1, updated_at = now()
  WHERE id = v_source_txn_id;

  UPDATE pos_transactions
  SET subtotal = COALESCE((SELECT SUM(line_total - COALESCE(tax_amount, 0)) FROM pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
      tax_amount = COALESCE((SELECT SUM(COALESCE(tax_amount, 0)) FROM pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
      total = COALESCE((SELECT SUM(line_total) FROM pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
      version = version + 1, updated_at = now()
  WHERE id = v_target_txn_id;

  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'items_transferred', v_moved_count
  );
END;
$$ ;
