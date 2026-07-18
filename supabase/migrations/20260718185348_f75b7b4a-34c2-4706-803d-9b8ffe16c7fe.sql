
-- ============================================================
-- Batch T6 · POS Transaction Engine — Internal helpers
-- ============================================================
-- Sale/return/void previously repeated the same warehouse-resolution
-- and stock_movements-insert boilerplate, and void skipped GL posting
-- entirely (leaving a ledger gap after T5). This batch extracts three
-- SECURITY DEFINER internal helpers and wires the ledger-reversal
-- helper into process_pos_void.
--
-- Naming: leading underscore + "_pos_" scopes the helpers as
-- internal-only. EXECUTE is revoked from PUBLIC (granted only to
-- service_role and to authenticated for use inside RPC bodies).

-- 1) Warehouse resolver ---------------------------------------
CREATE OR REPLACE FUNCTION public._pos_resolve_branch_warehouse(
  _org_id uuid, _biz_id uuid, _branch_id uuid, _shift_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_wh uuid;
BEGIN
  IF _shift_id IS NOT NULL THEN
    SELECT warehouse_id INTO v_wh FROM public.pos_shifts
    WHERE id = _shift_id AND organization_id = _org_id AND business_id = _biz_id;
  END IF;
  IF v_wh IS NOT NULL THEN RETURN v_wh; END IF;

  SELECT id INTO v_wh FROM public.warehouses
   WHERE organization_id = _org_id AND business_id = _biz_id
     AND branch_id = _branch_id AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC, created_at ASC LIMIT 1;
  RETURN v_wh;
END $function$;

REVOKE ALL ON FUNCTION public._pos_resolve_branch_warehouse(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._pos_resolve_branch_warehouse(uuid, uuid, uuid, uuid) TO authenticated, service_role;

-- 2) Stock-movement writer -------------------------------------
CREATE OR REPLACE FUNCTION public._pos_write_stock_movement(
  _org_id uuid, _biz_id uuid, _branch_id uuid,
  _product_id uuid, _warehouse_id uuid,
  _movement_type text, _quantity numeric, _unit_cost numeric,
  _txn_id uuid, _txn_number text, _actor uuid,
  _lot_number text DEFAULT NULL, _serial_number text DEFAULT NULL,
  _packaging_id uuid DEFAULT NULL, _uom_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _warehouse_id IS NULL THEN
    RAISE EXCEPTION '_pos_write_stock_movement: warehouse_id is required (product=%, txn=%)', _product_id, _txn_id
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, product_id, warehouse_id,
    movement_type, quantity, unit_cost, reference_type, reference_id,
    notes, created_by, movement_date,
    lot_number, serial_number, source_packaging_id, source_uom_id
  ) VALUES (
    _org_id, _biz_id, _branch_id, _product_id, _warehouse_id,
    _movement_type, _quantity, COALESCE(_unit_cost, 0),
    'pos_transaction', _txn_id,
    CASE _movement_type
      WHEN 'pos_return' THEN 'POS Return: '
      WHEN 'pos_sale' THEN 'POS Sale: '
      ELSE 'POS ' || _movement_type || ': '
    END || COALESCE(_txn_number, _txn_id::text),
    _actor, now(),
    _lot_number, _serial_number, _packaging_id, _uom_id);
END $function$;

REVOKE ALL ON FUNCTION public._pos_write_stock_movement(
  uuid, uuid, uuid, uuid, uuid, text, numeric, numeric,
  uuid, text, uuid, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._pos_write_stock_movement(
  uuid, uuid, uuid, uuid, uuid, text, numeric, numeric,
  uuid, text, uuid, text, text, uuid, uuid) TO authenticated, service_role;

-- 3) Ledger reversal helper -----------------------------------
-- Given a POS transaction that has a journal_entry_id (posted by T5),
-- post a fully reversing journal entry (swap debits/credits) and
-- return the reversal id. Idempotent: if the txn has no journal
-- entry (never posted) it returns NULL.
CREATE OR REPLACE FUNCTION public._pos_reverse_transaction_gl(_txn_id uuid, _actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_txn RECORD; v_je RECORD; v_lines jsonb := '[]'::jsonb; v_line RECORD;
  v_reversal_id uuid; v_entry_number text;
BEGIN
  SELECT * INTO v_txn FROM public.pos_transactions WHERE id = _txn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS transaction not found: %', _txn_id; END IF;
  IF v_txn.journal_entry_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_je FROM public.journal_entries WHERE id = v_txn.journal_entry_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  FOR v_line IN
    SELECT account_id, debit_amount AS debit, credit_amount AS credit, description, branch_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_txn.journal_entry_id
  LOOP
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_line.account_id,
      'debit',  COALESCE(v_line.credit, 0),
      'credit', COALESCE(v_line.debit, 0),
      'description', 'Reversal — ' || COALESCE(v_line.description, ''),
      'branch_id', v_line.branch_id));
  END LOOP;

  IF jsonb_array_length(v_lines) = 0 THEN RETURN NULL; END IF;

  SELECT COALESCE(
    'JE-' || LPAD(
      (COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text,
      5, '0'), 'JE-00001')
  INTO v_entry_number
  FROM public.journal_entries WHERE organization_id = v_txn.organization_id;

  v_reversal_id := public.post_journal_entry_atomic(
    v_txn.organization_id, v_txn.business_id, v_entry_number,
    now()::date,
    'POS-VOID-' || v_txn.transaction_number,
    'POS void — reversal of ' || v_je.entry_number,
    'pos_transaction_void', _txn_id,
    _actor, false, false, v_lines, NULL, NULL, NULL, v_txn.branch_id);

  RETURN v_reversal_id;
END $function$;

REVOKE ALL ON FUNCTION public._pos_reverse_transaction_gl(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._pos_reverse_transaction_gl(uuid, uuid) TO authenticated, service_role;

-- 4) Wire the reversal into process_pos_void -------------------
CREATE OR REPLACE FUNCTION public.process_pos_void(
  p_organization_id uuid, p_transaction_id uuid, p_void_reason_id uuid,
  p_void_note text DEFAULT NULL, p_voided_by uuid DEFAULT NULL,
  p_override_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx RECORD; v_reason RECORD; v_shift_status text; v_warehouse_id uuid;
  v_item RECORD; v_cash_refund numeric := 0; v_has_return boolean;
  v_reversal_je uuid;
BEGIN
  SELECT * INTO v_tx FROM public.pos_transactions
   WHERE id = p_transaction_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_tx IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_found','details','Transaction not found');
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_tx.branch_id);

  IF v_tx.status = 'voided' THEN
    RETURN jsonb_build_object('success',false,'error','already_voided','details','Already voided');
  END IF;
  IF v_tx.status <> 'completed' THEN
    RETURN jsonb_build_object('success',false,'error','invalid_status',
      'details','Only completed transactions can be voided (status: '||v_tx.status||')');
  END IF;
  SELECT status INTO v_shift_status FROM public.pos_shifts WHERE id = v_tx.shift_id;
  IF v_shift_status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success',false,'error','shift_not_open',
      'details','Voids are only allowed within the same open shift. Use a return instead.');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.pos_transactions
     WHERE original_transaction_id = p_transaction_id
       AND transaction_type = 'return' AND status <> 'voided') INTO v_has_return;
  IF v_has_return THEN
    RETURN jsonb_build_object('success',false,'error','return_exists',
      'details','A return has already been processed against this transaction; void is no longer allowed.');
  END IF;
  SELECT * INTO v_reason FROM public.pos_void_reasons WHERE id = p_void_reason_id AND is_active = true;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','invalid_reason',
      'details','Void reason is required and must be active');
  END IF;
  IF v_reason.requires_note AND COALESCE(btrim(p_void_note),'') = '' THEN
    RETURN jsonb_build_object('success',false,'error','note_required',
      'details','Selected void reason requires a note');
  END IF;

  PERFORM public.assert_manager_override('void_above_threshold', v_tx.total,
    p_organization_id, v_tx.business_id, v_tx.shift_id, p_override_id,
    'pos_transactions', p_transaction_id);

  -- T6: use shared warehouse resolver instead of copy-pasted lookup.
  v_warehouse_id := public._pos_resolve_branch_warehouse(
    v_tx.organization_id, v_tx.business_id, v_tx.branch_id, v_tx.shift_id);

  FOR v_item IN SELECT ti.product_id, ti.quantity, ti.cost_price, p.track_inventory
      FROM public.pos_transaction_items ti
      LEFT JOIN public.products p ON p.id = ti.product_id
     WHERE ti.transaction_id = p_transaction_id LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      -- T6: shared stock_movements writer.
      PERFORM public._pos_write_stock_movement(
        v_tx.organization_id, v_tx.business_id, v_tx.branch_id,
        v_item.product_id, v_warehouse_id,
        'pos_return', v_item.quantity, v_item.cost_price,
        p_transaction_id, v_tx.transaction_number || ' (VOID:' || v_reason.code || ')',
        p_voided_by);
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(amount),0) INTO v_cash_refund FROM public.pos_transaction_payments
   WHERE transaction_id = p_transaction_id AND payment_method = 'cash'
     AND COALESCE(status,'completed') <> 'voided';
  IF v_cash_refund > 0 THEN
    UPDATE public.pos_shifts SET expected_cash = COALESCE(expected_cash,0) - v_cash_refund, updated_at = now()
     WHERE id = v_tx.shift_id;
  END IF;

  UPDATE public.pos_transactions SET status='voided', reversal_type='void_post_payment',
    voided_by=p_voided_by, voided_at=now(), void_reason=v_reason.code, void_reason_id=v_reason.id,
    void_note=NULLIF(btrim(COALESCE(p_void_note,'')),''), void_override_id=p_override_id, updated_at=now()
   WHERE id = p_transaction_id;
  UPDATE public.pos_transaction_payments SET status='voided' WHERE transaction_id = p_transaction_id;

  -- T6 + T5: post the reversing GL entry inline. Sale posted a JE via
  -- trg_pos_transaction_post_sale_gl; void must reverse it here so the
  -- ledger nets to zero within the same shift.
  BEGIN
    v_reversal_je := public._pos_reverse_transaction_gl(p_transaction_id, p_voided_by);
  EXCEPTION WHEN OTHERS THEN
    -- Do NOT roll back the void for a GL reversal hiccup. Log to
    -- pos_shift_close_errors so ops can replay; the void itself must
    -- proceed so the cashier is unblocked.
    INSERT INTO public.pos_shift_close_errors (
      shift_id, organization_id, business_id, error_message, error_detail
    ) VALUES (
      v_tx.shift_id, v_tx.organization_id, v_tx.business_id, SQLERRM,
      jsonb_build_object('sqlstate', SQLSTATE, 'phase', 'void_reversal',
                         'transaction_id', p_transaction_id));
    v_reversal_je := NULL;
  END;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides SET transaction_id = p_transaction_id,
      metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
        'void_reason_code', v_reason.code, 'voided_amount', v_tx.total,
        'reversal_journal_entry_id', v_reversal_je)
     WHERE id = p_override_id;
  END IF;

  RETURN jsonb_build_object('success',true,'transaction_id',p_transaction_id,
    'transaction_number',v_tx.transaction_number,
    'voided_amount',v_tx.total,'reversal_type','void_post_payment',
    'reversal_journal_entry_id', v_reversal_je);
END $function$;
