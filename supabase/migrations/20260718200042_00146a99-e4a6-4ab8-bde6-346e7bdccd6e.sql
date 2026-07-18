
CREATE OR REPLACE FUNCTION public.process_pos_void(
  p_transaction_id uuid,
  p_organization_id uuid,
  p_voided_by uuid,
  p_void_reason_id uuid,
  p_void_note text DEFAULT NULL,
  p_override_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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

  -- Shared warehouse resolver.
  v_warehouse_id := public._pos_resolve_branch_warehouse(
    v_tx.organization_id, v_tx.business_id, v_tx.branch_id, v_tx.shift_id);

  -- T8: reverse stock through the lot-aware helper, guarded by the same
  -- (product, warehouse) advisory lock the sale/return paths take. This
  -- prevents a concurrent sale on the same SKU from observing a partial
  -- state while the void is rebuilding lot_state.
  FOR v_item IN
    SELECT ti.product_id,
           ti.quantity,
           ti.cost_price,
           ti.lot_allocations,
           ti.packaging_id,
           ti.display_uom_id,
           p.track_inventory,
           COALESCE(p.is_lot_tracked, false) AS is_lot_tracked
      FROM public.pos_transaction_items ti
      LEFT JOIN public.products p ON p.id = ti.product_id
     WHERE ti.transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(v_item.product_id::text || ':' || v_warehouse_id::text, 0)
      );

      PERFORM public._pos_apply_lot_consumption(
        v_tx.organization_id,
        v_tx.business_id,
        v_tx.branch_id,
        v_warehouse_id,
        v_item.product_id,
        p_transaction_id,
        v_tx.transaction_number || ' (VOID:' || v_reason.code || ')',
        p_voided_by,
        v_item.lot_allocations,
        v_item.quantity,
        v_item.cost_price,
        v_item.is_lot_tracked,
        'in',
        v_item.packaging_id,
        v_item.display_uom_id
      );
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

  -- Post the reversing GL entry inline. Sale posted a JE via
  -- trg_pos_transaction_post_sale_gl; void must reverse it here so the
  -- ledger nets to zero within the same shift.
  BEGIN
    v_reversal_je := public._pos_reverse_transaction_gl(p_transaction_id, p_voided_by);
  EXCEPTION WHEN OTHERS THEN
    -- Do NOT roll back the void for a GL reversal hiccup. Log to
    -- pos_shift_close_errors so ops can replay; the void itself must
    -- proceed so the cashier is unblocked.
    INSERT INTO public.pos_shift_close_errors (
      organization_id, business_id, branch_id, shift_id,
      transaction_id, error_kind, error_detail, sqlstate, actor_id
    ) VALUES (
      v_tx.organization_id, v_tx.business_id, v_tx.branch_id, v_tx.shift_id,
      p_transaction_id, 'void_gl_reversal_failed', SQLERRM, SQLSTATE, p_voided_by
    );
    v_reversal_je := NULL;
  END;

  RETURN jsonb_build_object('success', true, 'transaction_id', p_transaction_id,
    'reversal_journal_entry_id', v_reversal_je);
END
$fn$;
