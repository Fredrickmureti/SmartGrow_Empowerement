
CREATE OR REPLACE FUNCTION public.merge_table_orders(
  p_organization_id uuid,
  p_source_session_id uuid,
  p_target_session_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer_id uuid;
  v_source_txn_id uuid;
  v_target_txn_id uuid;
  v_moved_count int := 0;
  v_item record;
  v_target_session record;
BEGIN
  -- Get source pending transaction
  SELECT id INTO v_source_txn_id
  FROM pos_transactions
  WHERE table_session_id = p_source_session_id
    AND status = 'pending'
    AND organization_id = p_organization_id
  LIMIT 1
  FOR UPDATE;

  IF v_source_txn_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No pending order on source table');
  END IF;

  -- Get target pending transaction
  SELECT id INTO v_target_txn_id
  FROM pos_transactions
  WHERE table_session_id = p_target_session_id
    AND status = 'pending'
    AND organization_id = p_organization_id
  LIMIT 1
  FOR UPDATE;

  -- If target has no pending order, auto-create one
  IF v_target_txn_id IS NULL THEN
    -- Verify target session exists and is open
    SELECT * INTO v_target_session
    FROM pos_table_sessions
    WHERE id = p_target_session_id
      AND organization_id = p_organization_id
      AND closed_at IS NULL
    FOR UPDATE;

    IF v_target_session IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Target table session not found or already closed');
    END IF;

    -- Create a pending transaction on the target session
    INSERT INTO pos_transactions (
      organization_id, register_id, table_session_id,
      status, subtotal, tax_amount, total, transaction_type
    )
    SELECT
      p_organization_id, t.register_id, p_target_session_id,
      'pending', 0, 0, 0, 'sale'
    FROM pos_transactions t
    WHERE t.id = v_source_txn_id
    RETURNING id INTO v_target_txn_id;
  END IF;

  -- Create audit transfer record
  INSERT INTO pos_table_transfers (organization_id, transfer_type, source_session_id, target_session_id, notes, created_by)
  VALUES (p_organization_id, 'merge', p_source_session_id, p_target_session_id, p_notes, p_user_id)
  RETURNING id INTO v_transfer_id;

  -- Move all items from source to target and record each
  FOR v_item IN
    SELECT id, quantity FROM pos_transaction_items WHERE transaction_id = v_source_txn_id
  LOOP
    UPDATE pos_transaction_items SET transaction_id = v_target_txn_id WHERE id = v_item.id;
    INSERT INTO pos_transfer_items (transfer_id, transaction_item_id, quantity)
    VALUES (v_transfer_id, v_item.id, v_item.quantity);
    v_moved_count := v_moved_count + 1;
  END LOOP;

  -- Recalculate target transaction totals
  UPDATE pos_transactions
  SET subtotal = COALESCE((SELECT SUM(line_total - COALESCE(tax_amount, 0)) FROM pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
      tax_amount = COALESCE((SELECT SUM(COALESCE(tax_amount, 0)) FROM pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
      total = COALESCE((SELECT SUM(line_total) FROM pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
      version = version + 1,
      updated_at = now()
  WHERE id = v_target_txn_id;

  -- Void source transaction
  UPDATE pos_transactions
  SET status = 'voided', updated_at = now()
  WHERE id = v_source_txn_id;

  -- Close source session
  UPDATE pos_table_sessions
  SET status = 'closed', closed_at = now()
  WHERE id = p_source_session_id;

  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'items_moved', v_moved_count
  );
END;
$$;
