
-- =====================================================================
-- S1 · POS write-helper isolation (Batch T5/T6 of ADR 0082)
-- =====================================================================
-- Enforces at the DB level that pos_transaction_items and
-- pos_transaction_payments can only be written through the audited
-- `_pos_*` helpers. Any direct INSERT (present or future) raises.
--
-- Mechanism: session-variable capability token. Helpers set
-- `pos.writer = 'helper'` (LOCAL, so it dies at tx end). A BEFORE
-- INSERT trigger checks the token and raises otherwise. Legitimate
-- maintenance paths (archive/restore) set 'maintenance'.
-- =====================================================================

-- --------- 1. Capability-token helper (idempotent set) ---------------
CREATE OR REPLACE FUNCTION public._pos_set_writer_token(_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF _token NOT IN ('helper','maintenance') THEN
    RAISE EXCEPTION '_pos_set_writer_token: invalid token %', _token
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('pos.writer', _token, true);  -- LOCAL to tx
END $$;

-- --------- 2. Guard trigger fn ---------------------------------------
CREATE OR REPLACE FUNCTION public._pos_assert_helper_writer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_token text;
BEGIN
  v_token := current_setting('pos.writer', true);
  IF v_token IS NULL OR v_token = '' THEN
    RAISE EXCEPTION 'Direct write to % is forbidden. Route through _pos_insert_line / _pos_record_payment (ADR 0082 · S1).',
      TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Set pos.writer via _pos_set_writer_token(''helper'') or use an existing POS helper.';
  END IF;
  IF v_token NOT IN ('helper','maintenance') THEN
    RAISE EXCEPTION 'Unrecognised pos.writer token %; refusing write to %', v_token, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pos_items_helper_only ON public.pos_transaction_items;
CREATE TRIGGER trg_pos_items_helper_only
  BEFORE INSERT ON public.pos_transaction_items
  FOR EACH ROW EXECUTE FUNCTION public._pos_assert_helper_writer();

DROP TRIGGER IF EXISTS trg_pos_payments_helper_only ON public.pos_transaction_payments;
CREATE TRIGGER trg_pos_payments_helper_only
  BEFORE INSERT ON public.pos_transaction_payments
  FOR EACH ROW EXECUTE FUNCTION public._pos_assert_helper_writer();

-- --------- 3. Teach existing helpers to stamp the token --------------
CREATE OR REPLACE FUNCTION public._pos_insert_line(_txn_id uuid, _payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF _txn_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION '_pos_insert_line: _txn_id and _payload are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('pos.writer', 'helper', true);
  INSERT INTO public.pos_transaction_items (
    transaction_id, product_id, description, quantity, unit_price,
    discount_type, discount_value, tax_rate, tax_amount, line_total,
    cost_price, sort_order, tax_rate_id, etims_tax_code,
    packaging_id, display_uom_id, display_quantity, lot_allocations,
    original_item_id, return_reason_id, return_reason_note
  ) VALUES (
    _txn_id,
    NULLIF(_payload->>'product_id','')::uuid,
    _payload->>'description',
    COALESCE((_payload->>'quantity')::numeric, 0),
    COALESCE((_payload->>'unit_price')::numeric, 0),
    _payload->>'discount_type',
    COALESCE((_payload->>'discount_value')::numeric, 0),
    COALESCE((_payload->>'tax_rate')::numeric, 0),
    COALESCE((_payload->>'tax_amount')::numeric, 0),
    COALESCE((_payload->>'line_total')::numeric, 0),
    COALESCE((_payload->>'cost_price')::numeric, 0),
    COALESCE((_payload->>'sort_order')::int, 0),
    NULLIF(_payload->>'tax_rate_id','')::uuid,
    _payload->>'etims_tax_code',
    NULLIF(_payload->>'packaging_id','')::uuid,
    NULLIF(_payload->>'display_uom_id','')::uuid,
    NULLIF(_payload->>'display_quantity','')::numeric,
    CASE WHEN jsonb_typeof(_payload->'lot_allocations') = 'array'
         THEN _payload->'lot_allocations' ELSE NULL END,
    NULLIF(_payload->>'original_item_id','')::uuid,
    NULLIF(_payload->>'return_reason_id','')::uuid,
    NULLIF(_payload->>'return_reason_note','')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public._pos_record_payment(_txn_id uuid, _org_id uuid, _biz_id uuid, _branch_id uuid, _payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid; v_method text; v_amount numeric;
  v_tendered numeric; v_change numeric; v_meta jsonb;
BEGIN
  IF _txn_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION '_pos_record_payment: _txn_id and _payload are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_method   := _payload->>'payment_method';
  v_amount   := COALESCE((_payload->>'amount')::numeric, 0);
  v_tendered := COALESCE((_payload->>'tendered_amount')::numeric, v_amount);
  v_change   := COALESCE((_payload->>'change_given')::numeric, GREATEST(0, v_tendered - v_amount));
  v_meta := public.pos_validate_payment_line(_biz_id, v_method, _payload);

  PERFORM set_config('pos.writer', 'helper', true);
  INSERT INTO public.pos_transaction_payments (
    transaction_id, organization_id, business_id, branch_id,
    payment_method, amount, tendered_amount, change_given,
    reference, card_last_four, card_type, mpesa_receipt_number,
    status, processed_at,
    tender_kind, capture_mode_used,
    auth_state, auth_id, authorized_amount, vendor_txn_id
  ) VALUES (
    _txn_id, _org_id, _biz_id, _branch_id,
    v_method, v_amount, v_tendered, v_change,
    _payload->>'reference', _payload->>'card_last_four',
    _payload->>'card_type', _payload->>'mpesa_receipt_number',
    COALESCE(_payload->>'status','completed'), now(),
    v_meta->>'tender_kind', v_meta->>'capture_mode',
    NULLIF(_payload->>'auth_state',''),
    NULLIF(_payload->>'auth_id',''),
    NULLIF(_payload->>'authorized_amount','')::numeric,
    NULLIF(_payload->>'vendor_txn_id','')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

-- --------- 4. Route archival / restore under 'maintenance' -----------
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc WHERE proname='archive_old_pos_transactions'
      AND pronamespace='public'::regnamespace;
  IF v_src IS NOT NULL AND v_src !~ 'set_config\(''pos\.writer''' THEN
    EXECUTE replace(
      v_src,
      'AS $function$',
      'AS $function$ DECLARE _pos_writer_bootstrap text := set_config(''pos.writer'',''maintenance'',true); '
    );
  END IF;
END $$;

-- --------- 5. Rewrite attach_c2b_to_pos_transaction to use helper ----
CREATE OR REPLACE FUNCTION public.attach_c2b_to_pos_transaction(_c2b_id uuid, _pos_transaction_id uuid)
RETURNS pos_transaction_payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_c2b         public.mpesa_c2b_transactions%ROWTYPE;
  v_pos         public.pos_transactions%ROWTYPE;
  v_payment     public.pos_transaction_payments%ROWTYPE;
  v_paid_so_far numeric;
  v_remaining   numeric;
  v_new_id      uuid;
BEGIN
  SELECT * INTO v_c2b FROM public.mpesa_c2b_transactions WHERE id = _c2b_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M-Pesa transaction not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_c2b.is_reconciled OR v_c2b.matched_pos_transaction_id IS NOT NULL OR v_c2b.matched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'M-Pesa transaction % is already reconciled', v_c2b.trans_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_pos FROM public.pos_transactions WHERE id = _pos_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS transaction not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_pos.business_id IS NULL OR NOT public.user_has_business_access(v_pos.business_id) THEN
    RAISE EXCEPTION 'Not authorized to attach payments to this POS sale' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_c2b.organization_id IS DISTINCT FROM v_pos.organization_id THEN
    RAISE EXCEPTION 'M-Pesa payment belongs to a different organization' USING ERRCODE = 'check_violation';
  END IF;
  IF v_c2b.business_id IS NOT NULL AND v_c2b.business_id IS DISTINCT FROM v_pos.business_id THEN
    RAISE EXCEPTION 'M-Pesa payment belongs to a different business' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid_so_far
  FROM public.pos_transaction_payments
  WHERE transaction_id = v_pos.id AND status = 'completed';

  v_remaining := COALESCE(v_pos.total, 0) - v_paid_so_far;
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'POS sale already fully paid' USING ERRCODE = 'check_violation';
  END IF;

  IF v_c2b.trans_amount < v_remaining THEN
    RAISE EXCEPTION 'M-Pesa amount % is less than remaining balance %', v_c2b.trans_amount, v_remaining
      USING ERRCODE = 'check_violation';
  END IF;

  v_new_id := public._pos_record_payment(
    v_pos.id, v_pos.organization_id, v_pos.business_id, v_pos.branch_id,
    jsonb_build_object(
      'payment_method', 'mobile_money',
      'amount', v_remaining,
      'reference', v_c2b.trans_id,
      'mpesa_receipt_number', v_c2b.trans_id,
      'status', 'completed'
    )
  );

  SELECT * INTO v_payment FROM public.pos_transaction_payments WHERE id = v_new_id;

  UPDATE public.mpesa_c2b_transactions
     SET matched_pos_transaction_id = v_pos.id,
         is_reconciled = true,
         reconciled_at = now(),
         reconciled_by = auth.uid(),
         updated_at = now()
   WHERE id = v_c2b.id;

  RETURN v_payment;
END $function$;
