
-- Stage 8.5: route void / return / cash-movement override gates through
-- assert_manager_override. Same RPC signatures and return shapes; only the
-- override-decision logic moves into the matrix helper.

-- ============================================================
-- process_pos_void
-- ============================================================
CREATE OR REPLACE FUNCTION public.process_pos_void(
  p_organization_id uuid,
  p_transaction_id  uuid,
  p_void_reason_id  uuid,
  p_void_note       text DEFAULT NULL,
  p_voided_by       uuid DEFAULT NULL,
  p_override_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx           RECORD;
  v_reason       RECORD;
  v_shift_status text;
  v_warehouse_id uuid;
  v_item         RECORD;
  v_cash_refund  numeric := 0;
  v_has_return   boolean;
BEGIN
  SELECT * INTO v_tx FROM public.pos_transactions
   WHERE id = p_transaction_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_tx IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_found','details','Transaction not found');
  END IF;
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

  SELECT EXISTS (
    SELECT 1 FROM public.pos_transactions
     WHERE original_transaction_id = p_transaction_id
       AND transaction_type = 'return' AND status <> 'voided'
  ) INTO v_has_return;
  IF v_has_return THEN
    RETURN jsonb_build_object('success',false,'error','return_exists',
      'details','A return has already been processed against this transaction; void is no longer allowed.');
  END IF;

  SELECT * INTO v_reason FROM public.pos_void_reasons
   WHERE id = p_void_reason_id AND is_active = true;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','invalid_reason',
      'details','Void reason is required and must be active');
  END IF;
  IF v_reason.requires_note AND COALESCE(btrim(p_void_note),'') = '' THEN
    RETURN jsonb_build_object('success',false,'error','note_required',
      'details','Selected void reason requires a note');
  END IF;

  -- Stage 8.5: single matrix-backed gate (matrix action: void_above_threshold).
  -- assert_manager_override raises override_required / override_* on failure
  -- and stamps the override consumed atomically on success.
  PERFORM public.assert_manager_override(
    'void_above_threshold',
    v_tx.total,
    p_organization_id,
    v_tx.business_id,
    v_tx.shift_id,
    p_override_id,
    'pos_transactions',
    p_transaction_id
  );

  SELECT s.warehouse_id INTO v_warehouse_id FROM public.pos_shifts s WHERE s.id = v_tx.shift_id;
  IF v_warehouse_id IS NULL THEN
    SELECT id INTO v_warehouse_id FROM public.warehouses
     WHERE organization_id = v_tx.organization_id
       AND business_id     = v_tx.business_id
       AND branch_id       = v_tx.branch_id
       AND is_active       = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  FOR v_item IN
    SELECT ti.product_id, ti.quantity, ti.cost_price, p.track_inventory
      FROM public.pos_transaction_items ti
      LEFT JOIN public.products p ON p.id = ti.product_id
     WHERE ti.transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      IF v_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for branch % — cannot reverse stock for void', v_tx.branch_id
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date
      ) VALUES (
        v_tx.organization_id, v_tx.business_id, v_tx.branch_id,
        v_item.product_id, v_warehouse_id,
        'pos_return', v_item.quantity, COALESCE(v_item.cost_price,0),
        'pos_transaction', p_transaction_id,
        'Voided: '||v_tx.transaction_number||' — '||v_reason.code,
        p_voided_by, now()
      );
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(amount),0) INTO v_cash_refund
    FROM public.pos_transaction_payments
   WHERE transaction_id = p_transaction_id
     AND payment_method = 'cash'
     AND COALESCE(status,'completed') <> 'voided';
  IF v_cash_refund > 0 THEN
    UPDATE public.pos_shifts
       SET expected_cash = COALESCE(expected_cash,0) - v_cash_refund, updated_at = now()
     WHERE id = v_tx.shift_id;
  END IF;

  UPDATE public.pos_transactions
     SET status='voided', reversal_type='void_post_payment',
         voided_by=p_voided_by, voided_at=now(),
         void_reason=v_reason.code, void_reason_id=v_reason.id,
         void_note=NULLIF(btrim(COALESCE(p_void_note,'')),''),
         void_override_id=p_override_id, updated_at=now()
   WHERE id = p_transaction_id;

  UPDATE public.pos_transaction_payments SET status='voided' WHERE transaction_id = p_transaction_id;

  -- Helper already stamped consumed_at + consumed_table/ref_id; we just attach
  -- transaction context + reason metadata for audit (no status flip here).
  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides
       SET transaction_id = p_transaction_id,
           metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
             'void_reason_code', v_reason.code, 'voided_amount', v_tx.total)
     WHERE id = p_override_id;
  END IF;

  RETURN jsonb_build_object(
    'success',true,'transaction_id',p_transaction_id,
    'transaction_number',v_tx.transaction_number,
    'voided_amount',v_tx.total,'reversal_type','void_post_payment'
  );
END;
$function$;

-- ============================================================
-- process_pos_return
-- ============================================================
CREATE OR REPLACE FUNCTION public.process_pos_return(
  p_organization_id         uuid,
  p_register_id             uuid,
  p_shift_id                uuid,
  p_original_transaction_id uuid,
  p_items                   jsonb,
  p_refund_method           text DEFAULT 'cash',
  p_notes                   text DEFAULT NULL,
  p_created_by              uuid DEFAULT NULL,
  p_override_id             uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id       UUID;
  v_transaction_number   TEXT;
  v_register_code        TEXT;
  v_register_branch_id   UUID;
  v_register_business_id UUID;
  v_register_org_id      UUID;
  v_shift_warehouse_id   UUID;
  v_default_warehouse_id UUID;
  v_item                 JSONB;
  v_product_id           UUID;
  v_quantity             NUMERIC;
  v_track_inventory      BOOLEAN;
  v_subtotal             NUMERIC := 0;
  v_tax_amount           NUMERIC := 0;
  v_total                NUMERIC := 0;
  v_item_index           INT := 0;
  v_original_status      TEXT;
  v_original_business_id UUID;
  v_original_item_id     UUID;
  v_returnable           NUMERIC;
  v_item_total           NUMERIC;
  v_item_tax             NUMERIC;
  v_reason_id            UUID;
  v_reason_code          TEXT;
  v_reason_requires_note BOOLEAN;
  v_reason_note          TEXT;
  v_unit_price           NUMERIC;
  v_tax_rate             NUMERIC;
  v_cost_price           NUMERIC;
  v_description          TEXT;
  v_refund_tender        TEXT;
  v_is_cross_tender      BOOLEAN := false;
BEGIN
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;

  IF v_register_org_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization than supplied', p_register_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register has no branch context');
  END IF;

  SELECT status, business_id INTO v_original_status, v_original_business_id
  FROM public.pos_transactions
  WHERE id = p_original_transaction_id
    AND organization_id = p_organization_id;

  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;
  IF v_original_status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_voided',
      'details', 'Cannot return a voided transaction');
  END IF;
  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;
  IF v_original_business_id IS DISTINCT FROM v_register_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cross_company_return',
      'details', 'Original transaction belongs to a different company than this register');
  END IF;

  v_refund_tender := CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.pos_transaction_payments
     WHERE transaction_id = p_original_transaction_id
       AND payment_method = v_refund_tender
       AND COALESCE(status, 'completed') = 'completed'
  ) INTO v_is_cross_tender;

  -- Pre-flight: validate items, compute total. We need the total before
  -- calling assert_manager_override (matrix may threshold by amount).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    IF v_original_item_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_original_item',
        'details', 'Each return line must reference an original_item_id');
    END IF;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity',
        'details', 'Return quantity must be greater than zero');
    END IF;

    SELECT returnable_qty INTO v_returnable
    FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id
      AND original_transaction_id = p_original_transaction_id;

    IF v_returnable IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found',
        'details', 'Original item not found on this transaction');
    END IF;
    IF v_quantity > v_returnable THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_return',
        'details', format('Cannot return %s — only %s remaining for this line', v_quantity, v_returnable));
    END IF;

    v_reason_id := NULLIF(v_item->>'return_reason_id','')::UUID;
    IF v_reason_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_reason',
        'details', 'A return reason is required for every line');
    END IF;
    SELECT code, requires_note INTO v_reason_code, v_reason_requires_note
    FROM public.pos_return_reasons WHERE id = v_reason_id AND is_active = true;
    IF v_reason_code IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_reason',
        'details', 'Selected return reason is not valid');
    END IF;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    IF v_reason_requires_note AND v_reason_note IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_required',
        'details', format('Reason "%s" requires an explanatory note', v_reason_code));
    END IF;
    IF NOT v_reason_requires_note AND v_reason_note IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_not_allowed',
        'details', 'Free-text note only allowed for reason code "other"');
    END IF;

    SELECT unit_price, tax_rate INTO v_unit_price, v_tax_rate
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax   := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    v_subtotal   := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  -- Stage 8.5: matrix-backed refund gate (action: refund). For cross-tender
  -- refunds we additionally require an override of action `cross_tender_refund`
  -- — this is a stricter, named gate that the basic refund override cannot
  -- satisfy by reuse. Both calls go through assert_manager_override which
  -- stamps consumed_at atomically.
  IF v_is_cross_tender THEN
    PERFORM public.assert_manager_override(
      'cross_tender_refund', v_total, p_organization_id, v_register_business_id,
      p_shift_id, p_override_id, 'pos_transactions', NULL
    );
  ELSE
    PERFORM public.assert_manager_override(
      'refund', v_total, p_organization_id, v_register_business_id,
      p_shift_id, p_override_id, 'pos_transactions', NULL
    );
  END IF;

  SELECT warehouse_id INTO v_shift_warehouse_id
  FROM public.pos_shifts
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND register_id     = p_register_id;

  v_default_warehouse_id := v_shift_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id FROM public.warehouses
     WHERE organization_id = v_register_org_id
       AND business_id     = v_register_business_id
       AND branch_id       = v_register_branch_id
       AND is_active       = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, v_register_code);

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total,
    'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  -- Backfill consumed_ref_id now that we have the new transaction id.
  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides
       SET consumed_ref_id = v_transaction_id,
           transaction_id  = v_transaction_id,
           amount          = v_total,
           metadata        = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                              'original_transaction_id', p_original_transaction_id,
                              'refund_tender', v_refund_tender,
                              'is_cross_tender', v_is_cross_tender
                            )
     WHERE id = p_override_id;
  END IF;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_reason_id := (v_item->>'return_reason_id')::UUID;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');

    SELECT product_id, unit_price, tax_rate, cost_price, description
      INTO v_product_id, v_unit_price, v_tax_rate, v_cost_price, v_description
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;

    v_item_total := v_unit_price * v_quantity;
    v_item_tax   := v_item_total * COALESCE(v_tax_rate, 0) / 100;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      original_item_id, return_reason_id, return_reason_note
    ) VALUES (
      v_transaction_id, v_product_id, v_description, v_quantity,
      v_unit_price, NULL, 0,
      COALESCE(v_tax_rate, 0), v_item_tax, v_item_total + v_item_tax,
      v_cost_price, v_item_index,
      v_original_item_id, v_reason_id, v_reason_note
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = p_organization_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse for POS register branch %; create one before processing returns', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          p_organization_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          'pos_return', v_quantity, COALESCE(v_cost_price, 0),
          'pos_transaction', v_transaction_id,
          'POS Return: ' || v_transaction_number, p_created_by, now()
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  INSERT INTO public.pos_transaction_payments (
    transaction_id, payment_method, amount, reference, status,
    organization_id, business_id, branch_id
  ) VALUES (
    v_transaction_id, v_refund_tender, -v_total,
    'Refund - ' || v_transaction_number, 'completed',
    p_organization_id, v_register_business_id, v_register_branch_id
  );

  IF p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) - v_total,
        total_returns = COALESCE(total_returns, 0) + v_total,
        updated_at    = now()
    WHERE id = p_shift_id;
  ELSE
    UPDATE public.pos_shifts
    SET total_returns = COALESCE(total_returns, 0) + v_total,
        updated_at    = now()
    WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'refund_amount', v_total,
    'business_id', v_register_business_id,
    'branch_id', v_register_branch_id,
    'cross_tender', v_is_cross_tender
  );
END;
$function$;

-- ============================================================
-- process_pos_cash_movement
-- ============================================================
CREATE OR REPLACE FUNCTION public.process_pos_cash_movement(
  p_organization_id uuid,
  p_business_id     uuid,
  p_shift_id        uuid,
  p_register_id     uuid,
  p_movement_type   text,
  p_amount          numeric,
  p_reason_code     text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  p_performed_by    uuid DEFAULT NULL,
  p_override_id     uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_shift        record;
  v_register     record;
  v_type         record;
  v_signed_delta numeric;
  v_movement_id  uuid;
  v_je_id        uuid;
  v_je_number    text;
  v_lines        jsonb;
  v_user_id      uuid := COALESCE(p_performed_by, auth.uid());
  v_matrix_action text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;

  IF NOT public.user_has_module_permission(v_user_id, p_organization_id, p_business_id, 'pos', 'create') THEN
    RAISE EXCEPTION 'user lacks POS create permission for this business' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_shift FROM pos_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift is not open' USING ERRCODE = '22023';
  END IF;
  IF v_shift.register_id <> p_register_id THEN
    RAISE EXCEPTION 'register does not match shift' USING ERRCODE = '22023';
  END IF;
  IF v_shift.business_id <> p_business_id OR v_shift.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'shift does not belong to provided business/org' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_register FROM pos_registers WHERE id = p_register_id;
  IF NOT FOUND OR v_register.business_id <> p_business_id THEN
    RAISE EXCEPTION 'register not found in business' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_type
    FROM pos_cash_movement_types
   WHERE business_id = p_business_id
     AND movement_type = p_movement_type
     AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'movement type % not configured for business', p_movement_type USING ERRCODE = '22023';
  END IF;

  IF v_type.requires_reason
     AND COALESCE(NULLIF(TRIM(COALESCE(p_reason_code, p_reason, '')), ''), NULL) IS NULL THEN
    RAISE EXCEPTION 'reason is required for % movements', p_movement_type USING ERRCODE = '22023';
  END IF;

  -- Stage 8.5: matrix-backed override gate. Only the three movement types
  -- that have matrix entries are gated; opening_float / cash_in / pickup /
  -- correction / petty_cash_out remain ungated unless the type-level
  -- requires_manager_default flag is set (which we still honor below).
  v_matrix_action := CASE p_movement_type
    WHEN 'cash_out'     THEN 'cash_out_above_threshold'
    WHEN 'safe_drop'    THEN 'safe_drop'
    WHEN 'bank_deposit' THEN 'bank_deposit'
    ELSE NULL
  END;

  IF v_matrix_action IS NOT NULL THEN
    PERFORM public.assert_manager_override(
      v_matrix_action, p_amount, p_organization_id, p_business_id,
      p_shift_id, p_override_id, 'pos_cash_movements', NULL
    );
  ELSIF v_type.requires_manager_default THEN
    -- Type-level always-require flag (no matrix row): keep legacy behaviour
    -- (presence + freshness + scope + single-use). No threshold here.
    IF p_override_id IS NULL THEN
      RAISE EXCEPTION 'manager_override_required'
        USING ERRCODE = '42501', HINT = format('movement type %s requires manager approval', p_movement_type);
    END IF;
    PERFORM 1 FROM pos_manager_overrides
      WHERE id = p_override_id
        AND organization_id = p_organization_id
        AND register_id = p_register_id
        AND (shift_id IS NULL OR shift_id = p_shift_id)
        AND status = 'approved'
        AND consumed_at IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid or already-used manager override' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_signed_delta := CASE p_movement_type
    WHEN 'opening_float' THEN  p_amount
    WHEN 'cash_in'       THEN  p_amount
    WHEN 'correction'    THEN  p_amount
    WHEN 'cash_out'      THEN -p_amount
    WHEN 'pickup'        THEN -p_amount
    WHEN 'safe_drop'     THEN -p_amount
    WHEN 'bank_deposit'  THEN -p_amount
    WHEN 'petty_cash_out'THEN -p_amount
    ELSE 0
  END;

  INSERT INTO pos_cash_movements (
    organization_id, business_id, branch_id, shift_id, register_id,
    movement_type, amount, reason_code, reason, notes,
    performed_by, manager_override_id
  ) VALUES (
    p_organization_id, p_business_id, v_shift.branch_id, p_shift_id, p_register_id,
    p_movement_type, p_amount, p_reason_code, p_reason, p_notes,
    v_user_id, p_override_id
  ) RETURNING id INTO v_movement_id;

  UPDATE pos_shifts
     SET expected_cash = COALESCE(expected_cash, 0) + v_signed_delta,
         updated_at    = now()
   WHERE id = p_shift_id;

  IF v_type.gl_debit_account_id IS NOT NULL AND v_type.gl_credit_account_id IS NOT NULL THEN
    SELECT public.get_next_journal_entry_number(p_organization_id) INTO v_je_number;
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_type.gl_debit_account_id,
        'debit',  p_amount, 'credit', 0,
        'description', concat('POS ', p_movement_type, ' — shift ', v_shift.shift_number)
      ),
      jsonb_build_object(
        'account_id', v_type.gl_credit_account_id,
        'debit',  0, 'credit', p_amount,
        'description', concat('POS ', p_movement_type, ' — shift ', v_shift.shift_number)
      )
    );
    SELECT (public.post_journal_entry_atomic(
      p_organization_id, p_business_id, v_je_number, CURRENT_DATE,
      concat('POS-CASH-', v_movement_id::text),
      concat('POS cash movement: ', v_type.label),
      'pos_cash_movement', v_movement_id, v_user_id, false, false,
      v_lines, NULL, 1, p_movement_type, v_shift.branch_id
    ))::uuid INTO v_je_id;
    UPDATE pos_cash_movements SET journal_entry_id = v_je_id WHERE id = v_movement_id;
  END IF;

  -- Backfill consumed_ref_id with the new movement id (helper already
  -- stamped consumed_at + consumed_table for the matrix path; type-level
  -- legacy path needs a manual stamp).
  IF p_override_id IS NOT NULL THEN
    UPDATE pos_manager_overrides
       SET consumed_ref_id = v_movement_id,
           consumed_table  = COALESCE(consumed_table, 'pos_cash_movements'),
           consumed_at     = COALESCE(consumed_at, now()),
           status          = CASE WHEN status = 'approved' THEN 'consumed' ELSE status END
     WHERE id = p_override_id;
  END IF;

  RETURN json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'journal_entry_id', v_je_id,
    'gl_posted', v_je_id IS NOT NULL,
    'expected_cash_delta', v_signed_delta
  );
END;
$function$;
