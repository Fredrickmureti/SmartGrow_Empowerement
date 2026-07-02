
-- Stage A — POS Returns hardening: per-reason manager-override flag + description.
-- The existing `process_pos_return` already enforces:
--   - over-return via v_pos_returnable_qty
--   - reason required + requires_note check
--   - cross-tender refund via dedicated `cross_tender_refund` override action
--   - matrix-backed `refund` override gate
-- This migration adds a *reason-driven* always-require-override path so that
-- specific reason codes (e.g. high-value warranty returns, fraud-prone codes)
-- ALWAYS require manager approval regardless of refund amount.

ALTER TABLE public.pos_return_reasons
  ADD COLUMN IF NOT EXISTS requires_manager_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Re-create process_pos_return with the additional reason-level override gate.
-- Behavior change is purely additive: if any selected reason has
-- requires_manager_override=true AND no override was supplied, raise
-- 'override_required' so the client opens the manager PIN dialog. The
-- existing matrix-backed amount gates remain unchanged.

CREATE OR REPLACE FUNCTION public.process_pos_return(
  p_organization_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_original_transaction_id uuid,
  p_items jsonb,
  p_refund_method text DEFAULT 'cash'::text,
  p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid,
  p_override_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
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
  v_reason_requires_override BOOLEAN;
  v_reason_note          TEXT;
  v_unit_price           NUMERIC;
  v_tax_rate             NUMERIC;
  v_cost_price           NUMERIC;
  v_description          TEXT;
  v_refund_tender        TEXT;
  v_is_cross_tender      BOOLEAN := false;
  v_any_reason_needs_override BOOLEAN := false;
  v_override_reason_codes TEXT := '';
BEGIN
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;

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
  WHERE id = p_original_transaction_id AND organization_id = p_organization_id;

  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;
  IF v_original_status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_voided', 'details', 'Cannot return a voided transaction');
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

  -- Pre-flight: validate items, compute total, and detect any reason-driven
  -- override requirement.
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
    SELECT code, requires_note, requires_manager_override
      INTO v_reason_code, v_reason_requires_note, v_reason_requires_override
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
        'details', 'Free-text note only allowed for reasons that require a note');
    END IF;
    IF COALESCE(v_reason_requires_override, false) THEN
      v_any_reason_needs_override := true;
      IF position(v_reason_code IN v_override_reason_codes) = 0 THEN
        v_override_reason_codes := v_override_reason_codes ||
          CASE WHEN v_override_reason_codes = '' THEN '' ELSE ',' END || v_reason_code;
      END IF;
    END IF;

    SELECT unit_price, tax_rate INTO v_unit_price, v_tax_rate
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax   := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    v_subtotal   := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  -- Stage A: reason-level override gate. Hard requirement: if ANY selected
  -- reason has requires_manager_override=true and the cashier did not bring
  -- a manager override, refuse with override_required so the UI opens the
  -- manager PIN dialog. This bypasses the matrix amount thresholds — the
  -- reason itself demands approval regardless of value.
  IF v_any_reason_needs_override AND p_override_id IS NULL THEN
    RAISE EXCEPTION 'override_required'
      USING ERRCODE = 'check_violation',
            HINT = format('Reason(s) %s require manager approval', v_override_reason_codes),
            DETAIL = 'reason_requires_override';
  END IF;

  -- Matrix-backed refund + cross-tender override gates (unchanged).
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

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides
       SET consumed_ref_id = v_transaction_id,
           transaction_id  = v_transaction_id,
           amount          = v_total,
           metadata        = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                              'original_transaction_id', p_original_transaction_id,
                              'refund_tender', v_refund_tender,
                              'is_cross_tender', v_is_cross_tender,
                              'reason_required_override', v_any_reason_needs_override,
                              'override_reason_codes', v_override_reason_codes
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
    'cross_tender', v_is_cross_tender,
    'reason_required_override', v_any_reason_needs_override
  );
END;
$function$;

-- Trigger to keep updated_at fresh on pos_return_reasons edits.
CREATE OR REPLACE FUNCTION public._touch_pos_return_reasons_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_pos_return_reasons_updated_at ON public.pos_return_reasons;
CREATE TRIGGER trg_touch_pos_return_reasons_updated_at
  BEFORE UPDATE ON public.pos_return_reasons
  FOR EACH ROW EXECUTE FUNCTION public._touch_pos_return_reasons_updated_at();

-- Sanity assertion: confirm the new column exists and the function references it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pos_return_reasons'
      AND column_name='requires_manager_override'
  ) THEN
    RAISE EXCEPTION 'Stage A migration aborted: requires_manager_override column missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname='process_pos_return'
      AND pg_get_functiondef(oid) LIKE '%requires_manager_override%'
  ) THEN
    RAISE EXCEPTION 'Stage A migration aborted: process_pos_return does not consult requires_manager_override';
  END IF;
END $$;
