-- =====================================================================
-- POS Wave Phase 8 — concurrency & idempotency for multi-terminal ops
-- Hold/recall/cancel, split bills, table merge/transfer.
-- All money is derived server-side; all mutations are version/status
-- guarded and return an explicit conflict instead of clobbering.
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. HOLD / CANCEL held orders (recall already hardened earlier)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hold_pos_transaction(
  p_register_id uuid,
  p_shift_id uuid,
  p_cart jsonb,
  p_notes text DEFAULT NULL
)
RETURNS public.pos_held_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reg record;
  v_shift record;
  v_lines jsonb := '[]'::jsonb;
  v_item jsonb;
  v_quote jsonb;
  v_row public.pos_held_transactions;
BEGIN
  IF p_register_id IS NULL OR p_shift_id IS NULL THEN
    RAISE EXCEPTION 'register_id and shift_id are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, business_id, branch_id, organization_id
    INTO v_reg
  FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'register_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_reg.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_reg.branch_id);

  SELECT id, status, register_id INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift_not_open_for_hold' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_shift.register_id IS DISTINCT FROM p_register_id THEN
    RAISE EXCEPTION 'shift_register_mismatch' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF COALESCE(jsonb_array_length(p_cart->'items'), 0) = 0 THEN
    RAISE EXCEPTION 'cannot_hold_empty_cart' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Re-price server-side; the browser's subtotal is never trusted.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cart->'items')
  LOOP
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_id',        v_item->>'id',
      'product_id',     v_item->>'product_id',
      'quantity',       COALESCE((v_item->>'quantity')::numeric, 0),
      'unit_price',     COALESCE((v_item->>'unit_price')::numeric, 0),
      'discount_type',  v_item->>'discount_type',
      'discount_value', COALESCE((v_item->>'discount_value')::numeric, 0),
      'packaging_id',   v_item->>'packaging_id',
      'display_uom_id', v_item->>'display_uom_id'
    ));
  END LOOP;

  v_quote := public.pos_quote_cart(
    p_register_id      => p_register_id,
    p_lines            => v_lines,
    p_contact_id       => NULLIF(p_cart->'customer'->>'id','')::uuid,
    p_cart_discount_type  => NULL,
    p_cart_discount_value => 0
  );

  INSERT INTO public.pos_held_transactions (
    organization_id, business_id, branch_id, register_id, shift_id,
    customer_name, customer_id, items, subtotal, tax_snapshot,
    held_by, notes, status
  ) VALUES (
    v_reg.organization_id, v_reg.business_id, v_reg.branch_id, p_register_id, p_shift_id,
    NULLIF(p_cart->'customer'->>'name',''),
    NULLIF(p_cart->'customer'->>'id','')::uuid,
    p_cart,
    COALESCE((v_quote->>'subtotal')::numeric, 0),
    v_quote,
    auth.uid(),
    NULLIF(p_notes, ''),
    'held'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.hold_pos_transaction(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hold_pos_transaction(uuid, uuid, jsonb, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_pos_held_transaction(p_held_id uuid)
RETURNS public.pos_held_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_held public.pos_held_transactions;
BEGIN
  IF p_held_id IS NULL THEN
    RAISE EXCEPTION 'held_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_held FROM public.pos_held_transactions WHERE id = p_held_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'held_order_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_held.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_held.branch_id);

  IF v_held.status <> 'held' THEN
    RAISE EXCEPTION 'held_order_already_%', v_held.status
      USING ERRCODE = 'invalid_parameter_value', DETAIL = 'held_order_not_cancellable';
  END IF;

  UPDATE public.pos_held_transactions
     SET status = 'cancelled', updated_at = now()
   WHERE id = p_held_id
  RETURNING * INTO v_held;
  RETURN v_held;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_pos_held_transaction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_pos_held_transaction(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 2. SPLIT BILLS — server-derived amounts, single-payer portions
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_split_bill_session(p_split_bill_id uuid)
RETURNS TABLE(session_id uuid, business_id uuid, branch_id uuid, organization_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT sb.table_session_id, sb.business_id, sb.branch_id, sb.organization_id
  FROM public.pos_split_bills sb WHERE sb.id = p_split_bill_id;
$function$;

REVOKE ALL ON FUNCTION public.pos_split_bill_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_split_bill_session(uuid) TO authenticated, service_role;

-- Recompute a portion's amount from its assigned items (authoritative).
CREATE OR REPLACE FUNCTION public.pos_recalc_split_portion(p_portion_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_amount numeric;
BEGIN
  SELECT COALESCE(SUM(ROUND(ti.line_total * (sbi.quantity / NULLIF(ti.quantity,0)), 2)), 0)
    INTO v_amount
  FROM public.pos_split_bill_items sbi
  JOIN public.pos_transaction_items ti ON ti.id = sbi.transaction_item_id
  WHERE sbi.portion_id = p_portion_id;

  UPDATE public.pos_split_bill_portions SET amount = v_amount WHERE id = p_portion_id;
  RETURN v_amount;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_recalc_split_portion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_recalc_split_portion(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.create_pos_split_bill(
  p_table_session_id uuid,
  p_split_type text,
  p_split_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_txn record;
  v_existing record;
  v_bill_id uuid;
  v_i integer;
  v_base numeric := 0;
  v_remainder numeric := 0;
  v_amount numeric;
BEGIN
  IF p_split_type NOT IN ('by_item','by_seat','equal','custom') THEN
    RAISE EXCEPTION 'invalid_split_type' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF COALESCE(p_split_count, 0) < 1 OR p_split_count > 50 THEN
    RAISE EXCEPTION 'invalid_split_count' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_session FROM public.pos_table_sessions WHERE id = p_table_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table_session_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_session.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  -- Concurrency: a split that already has a paid portion is immutable.
  SELECT sb.id,
         (SELECT count(*) FROM public.pos_split_bill_portions p
           WHERE p.split_bill_id = sb.id AND p.status = 'paid') AS paid_count
    INTO v_existing
  FROM public.pos_split_bills sb
  WHERE sb.table_session_id = p_table_session_id
  ORDER BY sb.created_at DESC LIMIT 1;

  IF v_existing.id IS NOT NULL AND v_existing.paid_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'conflict', true,
      'error', 'split_bill_has_paid_portions', 'split_bill_id', v_existing.id);
  END IF;
  IF v_existing.id IS NOT NULL THEN
    DELETE FROM public.pos_split_bills WHERE id = v_existing.id;
  END IF;

  SELECT id, total INTO v_txn
  FROM public.pos_transactions
  WHERE table_session_id = p_table_session_id AND status = 'pending'
  ORDER BY created_at DESC LIMIT 1;

  INSERT INTO public.pos_split_bills (
    organization_id, business_id, branch_id, table_session_id,
    split_type, split_count, created_by
  ) VALUES (
    v_session.organization_id, v_session.business_id, v_session.branch_id,
    p_table_session_id, p_split_type, p_split_count, auth.uid()
  ) RETURNING id INTO v_bill_id;

  IF p_split_type = 'equal' THEN
    v_base := FLOOR(COALESCE(v_txn.total, 0) / p_split_count * 100) / 100;
    v_remainder := ROUND(COALESCE(v_txn.total, 0) - (v_base * p_split_count), 2);
  END IF;

  FOR v_i IN 1..p_split_count LOOP
    v_amount := CASE WHEN p_split_type = 'equal'
                     THEN v_base + CASE WHEN v_i = 1 THEN v_remainder ELSE 0 END
                     ELSE 0 END;
    INSERT INTO public.pos_split_bill_portions (
      split_bill_id, portion_number, seat_label, amount, status
    ) VALUES (
      v_bill_id, v_i,
      CASE WHEN p_split_type = 'by_seat' THEN 'Seat ' || v_i ELSE NULL END,
      v_amount, 'pending'
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'split_bill_id', v_bill_id,
    'order_total', COALESCE(v_txn.total, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_pos_split_bill(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pos_split_bill(uuid, text, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_pos_split_item(
  p_portion_id uuid,
  p_transaction_item_id uuid,
  p_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_portion record;
  v_bill record;
  v_item record;
  v_assigned numeric;
  v_new_id uuid;
BEGIN
  SELECT * INTO v_portion FROM public.pos_split_bill_portions WHERE id = p_portion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portion_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_bill FROM public.pos_split_bills WHERE id = v_portion.split_bill_id;
  IF NOT public.user_can_access_business(auth.uid(), v_bill.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_bill.branch_id);

  IF v_portion.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'portion_already_' || v_portion.status);
  END IF;

  SELECT ti.* INTO v_item
  FROM public.pos_transaction_items ti
  JOIN public.pos_transactions t ON t.id = ti.transaction_id
  WHERE ti.id = p_transaction_item_id
    AND t.table_session_id = v_bill.table_session_id
    AND t.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'item_not_on_this_order' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF COALESCE(p_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Cannot assign more of a line than the order actually contains.
  SELECT COALESCE(SUM(sbi.quantity), 0) INTO v_assigned
  FROM public.pos_split_bill_items sbi
  JOIN public.pos_split_bill_portions p ON p.id = sbi.portion_id
  WHERE p.split_bill_id = v_bill.id AND sbi.transaction_item_id = p_transaction_item_id;

  IF v_assigned + p_quantity > v_item.quantity THEN
    RETURN jsonb_build_object('success', false, 'conflict', true,
      'error', 'over_assigned', 'already_assigned', v_assigned, 'line_quantity', v_item.quantity);
  END IF;

  INSERT INTO public.pos_split_bill_items (portion_id, transaction_item_id, quantity)
  VALUES (p_portion_id, p_transaction_item_id, p_quantity)
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('success', true, 'split_bill_item_id', v_new_id,
    'portion_amount', public.pos_recalc_split_portion(p_portion_id));
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_pos_split_item(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_pos_split_item(uuid, uuid, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.remove_pos_split_item(p_split_bill_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_portion record;
  v_bill record;
  v_portion_id uuid;
BEGIN
  SELECT portion_id INTO v_portion_id FROM public.pos_split_bill_items WHERE id = p_split_bill_item_id;
  IF v_portion_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'already_removed', true);
  END IF;
  SELECT * INTO v_portion FROM public.pos_split_bill_portions WHERE id = v_portion_id FOR UPDATE;
  SELECT * INTO v_bill FROM public.pos_split_bills WHERE id = v_portion.split_bill_id;
  IF NOT public.user_can_access_business(auth.uid(), v_bill.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_bill.branch_id);

  IF v_portion.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'portion_already_' || v_portion.status);
  END IF;

  DELETE FROM public.pos_split_bill_items WHERE id = p_split_bill_item_id;
  RETURN jsonb_build_object('success', true, 'portion_amount', public.pos_recalc_split_portion(v_portion_id));
END;
$function$;

REVOKE ALL ON FUNCTION public.remove_pos_split_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_pos_split_item(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pay_pos_split_portion(
  p_portion_id uuid,
  p_transaction_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_portion record;
  v_bill record;
  v_amount numeric;
BEGIN
  SELECT * INTO v_portion FROM public.pos_split_bill_portions WHERE id = p_portion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portion_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_bill FROM public.pos_split_bills WHERE id = v_portion.split_bill_id;
  IF NOT public.user_can_access_business(auth.uid(), v_bill.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_bill.branch_id);

  -- Idempotency / concurrency: the losing terminal is told, not silently ignored.
  IF v_portion.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'portion_already_paid',
      'amount', v_portion.amount, 'transaction_id', v_portion.transaction_id, 'paid_at', v_portion.paid_at);
  END IF;
  IF v_portion.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'portion_' || v_portion.status);
  END IF;

  -- Amount is re-derived server-side for item-based splits.
  IF EXISTS (SELECT 1 FROM public.pos_split_bill_items WHERE portion_id = p_portion_id) THEN
    v_amount := public.pos_recalc_split_portion(p_portion_id);
  ELSE
    v_amount := v_portion.amount;
  END IF;

  UPDATE public.pos_split_bill_portions
     SET status = 'paid', paid_at = now(), transaction_id = p_transaction_id, amount = v_amount
   WHERE id = p_portion_id;

  RETURN jsonb_build_object('success', true, 'portion_id', p_portion_id, 'amount', v_amount,
    'all_paid', NOT EXISTS (
      SELECT 1 FROM public.pos_split_bill_portions
      WHERE split_bill_id = v_portion.split_bill_id AND status = 'pending'));
END;
$function$;

REVOKE ALL ON FUNCTION public.pay_pos_split_portion(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_pos_split_portion(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_pos_split_bill(p_split_bill_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_bill record; v_paid integer;
BEGIN
  SELECT * INTO v_bill FROM public.pos_split_bills WHERE id = p_split_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'already_removed', true);
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_bill.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_bill.branch_id);

  SELECT count(*) INTO v_paid FROM public.pos_split_bill_portions
   WHERE split_bill_id = p_split_bill_id AND status = 'paid';
  IF v_paid > 0 THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'split_bill_has_paid_portions');
  END IF;

  DELETE FROM public.pos_split_bills WHERE id = p_split_bill_id;
  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_pos_split_bill(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_pos_split_bill(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 3. TABLE MERGE / ITEM TRANSFER — fix, harden, version-guard
-- ---------------------------------------------------------------
-- Ambiguous stale overload (p_user_id before p_notes) also duplicated money
-- when splitting a line. Remove it so named-argument calls resolve uniquely.
DROP FUNCTION IF EXISTS public.transfer_table_items(uuid, uuid, uuid, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION public.merge_table_orders(
  p_organization_id uuid,
  p_source_session_id uuid,
  p_target_session_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_expected_source_version integer DEFAULT NULL,
  p_expected_target_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transfer_id uuid;
  v_source record;
  v_target record;
  v_source_session record;
  v_target_session record;
  v_target_txn_id uuid;
  v_moved_count int := 0;
  v_item record;
BEGIN
  SELECT * INTO v_source_session FROM public.pos_table_sessions
   WHERE id = p_source_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'source_session_not_found');
  END IF;
  SELECT * INTO v_target_session FROM public.pos_table_sessions
   WHERE id = p_target_session_id FOR UPDATE;
  IF NOT FOUND OR v_target_session.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Target table session not found or already closed');
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_source_session.business_id)
     OR NOT public.user_can_access_business(auth.uid(), v_target_session.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_source_session.business_id IS DISTINCT FROM v_target_session.business_id THEN
    RAISE EXCEPTION 'cross_business_merge_denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_source_session.branch_id);
  PERFORM public.assert_pos_caller_branch_access(v_target_session.branch_id);

  SELECT id, version INTO v_source FROM public.pos_transactions
   WHERE table_session_id = p_source_session_id AND status = 'pending'
     AND organization_id = v_source_session.organization_id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No pending order on source table');
  END IF;

  SELECT id, version INTO v_target FROM public.pos_transactions
   WHERE table_session_id = p_target_session_id AND status = 'pending'
     AND organization_id = v_target_session.organization_id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF p_expected_source_version IS NOT NULL
     AND v_source.version IS DISTINCT FROM p_expected_source_version THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'source_order_changed',
      'current_version', v_source.version);
  END IF;
  IF p_expected_target_version IS NOT NULL AND v_target.id IS NOT NULL
     AND v_target.version IS DISTINCT FROM p_expected_target_version THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'target_order_changed',
      'current_version', v_target.version);
  END IF;

  v_target_txn_id := v_target.id;
  IF v_target_txn_id IS NULL THEN
    INSERT INTO public.pos_transactions (
      organization_id, register_id, table_session_id,
      status, subtotal, tax_amount, total, transaction_type
    )
    SELECT v_target_session.organization_id, t.register_id, p_target_session_id,
           'pending', 0, 0, 0, 'sale'
    FROM public.pos_transactions t WHERE t.id = v_source.id
    RETURNING id INTO v_target_txn_id;
  END IF;

  INSERT INTO public.pos_table_transfers (
    organization_id, business_id, transfer_type,
    source_session_id, target_session_id, notes, created_by
  ) VALUES (
    v_source_session.organization_id, v_source_session.business_id, 'merge',
    p_source_session_id, p_target_session_id, p_notes, COALESCE(auth.uid(), p_user_id)
  ) RETURNING id INTO v_transfer_id;

  FOR v_item IN SELECT id, quantity FROM public.pos_transaction_items WHERE transaction_id = v_source.id
  LOOP
    UPDATE public.pos_transaction_items SET transaction_id = v_target_txn_id WHERE id = v_item.id;
    INSERT INTO public.pos_transfer_items (transfer_id, transaction_item_id, quantity)
    VALUES (v_transfer_id, v_item.id, v_item.quantity);
    v_moved_count := v_moved_count + 1;
  END LOOP;

  UPDATE public.pos_transactions
     SET subtotal = COALESCE((SELECT SUM(line_total - COALESCE(tax_amount,0)) FROM public.pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
         tax_amount = COALESCE((SELECT SUM(COALESCE(tax_amount,0)) FROM public.pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
         total = COALESCE((SELECT SUM(line_total) FROM public.pos_transaction_items WHERE transaction_id = v_target_txn_id), 0),
         version = version + 1, updated_at = now()
   WHERE id = v_target_txn_id;

  UPDATE public.pos_transactions
     SET status = 'voided', subtotal = 0, tax_amount = 0, total = 0,
         version = version + 1, updated_at = now()
   WHERE id = v_source.id;

  UPDATE public.pos_table_sessions
     SET status = 'closed', closed_at = now()
   WHERE id = p_source_session_id;

  RETURN jsonb_build_object('success', true, 'transfer_id', v_transfer_id,
    'items_moved', v_moved_count, 'target_transaction_id', v_target_txn_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.merge_table_orders(uuid, uuid, uuid, uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_table_orders(uuid, uuid, uuid, uuid, text, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.transfer_table_items(
  p_organization_id uuid,
  p_source_session_id uuid,
  p_target_session_id uuid,
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_expected_source_version integer DEFAULT NULL,
  p_expected_target_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transfer_id uuid;
  v_source_session record;
  v_target_session record;
  v_source record;
  v_target record;
  v_item_spec jsonb;
  v_current_item record;
  v_moved_count int := 0;
  v_transfer_qty numeric;
  v_original_qty numeric;
  v_new_tax numeric;
  v_new_total numeric;
BEGIN
  SELECT * INTO v_source_session FROM public.pos_table_sessions WHERE id = p_source_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'source_session_not_found');
  END IF;
  SELECT * INTO v_target_session FROM public.pos_table_sessions WHERE id = p_target_session_id FOR UPDATE;
  IF NOT FOUND OR v_target_session.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Target table session not found or already closed');
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_source_session.business_id)
     OR NOT public.user_can_access_business(auth.uid(), v_target_session.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_source_session.business_id IS DISTINCT FROM v_target_session.business_id THEN
    RAISE EXCEPTION 'cross_business_transfer_denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_source_session.branch_id);
  PERFORM public.assert_pos_caller_branch_access(v_target_session.branch_id);

  SELECT id, version INTO v_source FROM public.pos_transactions
   WHERE table_session_id = p_source_session_id AND status = 'pending'
     AND organization_id = v_source_session.organization_id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Source table has no active order');
  END IF;

  SELECT id, version INTO v_target FROM public.pos_transactions
   WHERE table_session_id = p_target_session_id AND status = 'pending'
     AND organization_id = v_target_session.organization_id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_target.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Target table has no active order');
  END IF;

  IF p_expected_source_version IS NOT NULL
     AND v_source.version IS DISTINCT FROM p_expected_source_version THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'source_order_changed',
      'current_version', v_source.version);
  END IF;
  IF p_expected_target_version IS NOT NULL
     AND v_target.version IS DISTINCT FROM p_expected_target_version THEN
    RETURN jsonb_build_object('success', false, 'conflict', true, 'error', 'target_order_changed',
      'current_version', v_target.version);
  END IF;

  INSERT INTO public.pos_table_transfers (
    organization_id, business_id, transfer_type,
    source_session_id, target_session_id, notes, created_by
  ) VALUES (
    v_source_session.organization_id, v_source_session.business_id, 'transfer_items',
    p_source_session_id, p_target_session_id, p_notes, COALESCE(auth.uid(), p_user_id)
  ) RETURNING id INTO v_transfer_id;

  FOR v_item_spec IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_current_item FROM public.pos_transaction_items
     WHERE id = (v_item_spec->>'transaction_item_id')::uuid FOR UPDATE;
    IF v_current_item IS NULL THEN
      RAISE EXCEPTION 'Item % not found', v_item_spec->>'transaction_item_id';
    END IF;
    IF v_current_item.transaction_id IS DISTINCT FROM v_source.id THEN
      RETURN jsonb_build_object('success', false, 'conflict', true,
        'error', 'item_no_longer_on_source_order', 'transaction_item_id', v_current_item.id);
    END IF;

    v_transfer_qty := COALESCE((v_item_spec->>'quantity')::numeric, 0);
    v_original_qty := v_current_item.quantity;
    IF v_transfer_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_transfer_quantity' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_transfer_qty >= v_original_qty THEN
      UPDATE public.pos_transaction_items SET transaction_id = v_target.id WHERE id = v_current_item.id;
    ELSE
      v_new_tax   := ROUND(COALESCE(v_current_item.tax_amount, 0) * v_transfer_qty / v_original_qty, 2);
      v_new_total := ROUND(v_current_item.line_total * v_transfer_qty / v_original_qty, 2);

      UPDATE public.pos_transaction_items
         SET quantity = v_original_qty - v_transfer_qty,
             tax_amount = COALESCE(v_current_item.tax_amount, 0) - v_new_tax,
             line_total = v_current_item.line_total - v_new_total
       WHERE id = v_current_item.id;

      INSERT INTO public.pos_transaction_items (
        transaction_id, product_id, description, quantity, unit_price,
        discount_type, discount_value, tax_rate, tax_amount, line_total,
        cost_price, sort_order, tax_rate_id, etims_tax_code
      ) VALUES (
        v_target.id, v_current_item.product_id, v_current_item.description,
        v_transfer_qty, v_current_item.unit_price,
        v_current_item.discount_type, v_current_item.discount_value,
        v_current_item.tax_rate, v_new_tax, v_new_total,
        v_current_item.cost_price, v_current_item.sort_order,
        v_current_item.tax_rate_id, v_current_item.etims_tax_code
      );
    END IF;

    INSERT INTO public.pos_transfer_items (transfer_id, transaction_item_id, quantity)
    VALUES (v_transfer_id, v_current_item.id, v_transfer_qty);
    v_moved_count := v_moved_count + 1;
  END LOOP;

  UPDATE public.pos_transactions
     SET subtotal = COALESCE((SELECT SUM(line_total - COALESCE(tax_amount,0)) FROM public.pos_transaction_items WHERE transaction_id = v_source.id), 0),
         tax_amount = COALESCE((SELECT SUM(COALESCE(tax_amount,0)) FROM public.pos_transaction_items WHERE transaction_id = v_source.id), 0),
         total = COALESCE((SELECT SUM(line_total) FROM public.pos_transaction_items WHERE transaction_id = v_source.id), 0),
         version = version + 1, updated_at = now()
   WHERE id = v_source.id;

  UPDATE public.pos_transactions
     SET subtotal = COALESCE((SELECT SUM(line_total - COALESCE(tax_amount,0)) FROM public.pos_transaction_items WHERE transaction_id = v_target.id), 0),
         tax_amount = COALESCE((SELECT SUM(COALESCE(tax_amount,0)) FROM public.pos_transaction_items WHERE transaction_id = v_target.id), 0),
         total = COALESCE((SELECT SUM(line_total) FROM public.pos_transaction_items WHERE transaction_id = v_target.id), 0),
         version = version + 1, updated_at = now()
   WHERE id = v_target.id;

  RETURN jsonb_build_object('success', true, 'transfer_id', v_transfer_id,
    'items_transferred', v_moved_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.transfer_table_items(uuid, uuid, uuid, jsonb, text, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_table_items(uuid, uuid, uuid, jsonb, text, uuid, integer, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 4. RLS — client reads scoped to business/branch; writes via RPC only
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage split bills in their organization" ON public.pos_split_bills;
DROP POLICY IF EXISTS "Users can view split bills in their organization" ON public.pos_split_bills;
CREATE POLICY "pos_split_bills_select_v3" ON public.pos_split_bills
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

DROP POLICY IF EXISTS "Users can manage split bill portions" ON public.pos_split_bill_portions;
DROP POLICY IF EXISTS "Users can view split bill portions" ON public.pos_split_bill_portions;
CREATE POLICY "pos_split_bill_portions_select_v3" ON public.pos_split_bill_portions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pos_split_bills sb
    WHERE sb.id = pos_split_bill_portions.split_bill_id
      AND public.user_can_access_business(auth.uid(), sb.business_id)
      AND (sb.branch_id IS NULL OR public.can_access_branch(auth.uid(), sb.branch_id))));

DROP POLICY IF EXISTS "Users can manage split bill items" ON public.pos_split_bill_items;
DROP POLICY IF EXISTS "Users can view split bill items" ON public.pos_split_bill_items;
CREATE POLICY "pos_split_bill_items_select_v3" ON public.pos_split_bill_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pos_split_bill_portions p
    JOIN public.pos_split_bills sb ON sb.id = p.split_bill_id
    WHERE p.id = pos_split_bill_items.portion_id
      AND public.user_can_access_business(auth.uid(), sb.business_id)
      AND (sb.branch_id IS NULL OR public.can_access_branch(auth.uid(), sb.branch_id))));

DROP POLICY IF EXISTS "Users can manage table transfers in their organization" ON public.pos_table_transfers;
DROP POLICY IF EXISTS "Users can view table transfers in their organization" ON public.pos_table_transfers;
CREATE POLICY "pos_table_transfers_select_v3" ON public.pos_table_transfers
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "Users can manage transfer items" ON public.pos_transfer_items;
DROP POLICY IF EXISTS "Users can view transfer items" ON public.pos_transfer_items;
CREATE POLICY "pos_transfer_items_select_v3" ON public.pos_transfer_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pos_table_transfers tt
    WHERE tt.id = pos_transfer_items.transfer_id
      AND public.user_can_access_business(auth.uid(), tt.business_id)));

-- Client may read; every mutation must go through the SECURITY DEFINER RPCs.
REVOKE INSERT, UPDATE, DELETE ON public.pos_split_bills FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pos_split_bill_portions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pos_split_bill_items FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pos_table_transfers FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pos_transfer_items FROM authenticated;
GRANT SELECT ON public.pos_split_bills TO authenticated;
GRANT SELECT ON public.pos_split_bill_portions TO authenticated;
GRANT SELECT ON public.pos_split_bill_items TO authenticated;
GRANT SELECT ON public.pos_table_transfers TO authenticated;
GRANT SELECT ON public.pos_transfer_items TO authenticated;
GRANT ALL ON public.pos_split_bills TO service_role;
GRANT ALL ON public.pos_split_bill_portions TO service_role;
GRANT ALL ON public.pos_split_bill_items TO service_role;
GRANT ALL ON public.pos_table_transfers TO service_role;
GRANT ALL ON public.pos_transfer_items TO service_role;